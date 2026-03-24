import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { BROKER_PID_FILE, BROKER_PORT_FILE } from "../constants.ts";
import type { Storage } from "../storage/storage.ts";
import { SessionManager } from "../sessions/manager.ts";
import { handleSessionRoutes } from "../sessions/routes.ts";
import { ForkManager } from "../fork/manager.ts";
import { handleAskRoute } from "../fork/routes.ts";
import type { ForkerFn } from "../fork/types.ts";
import { SummaryEngine } from "../summary/engine.ts";
import type { GenerateFn, QueryFn, EnrichFn } from "../summary/types.ts";
import { DEFAULT_BROKER_CONFIG, type BrokerConfig, type BrokerStatus } from "./types.ts";

export interface BrokerDeps {
  forker?: ForkerFn;
  summaryGenerate?: GenerateFn;
  summaryQuery?: QueryFn;
  summaryEnrich?: EnrichFn;
}

export class BrokerServer {
  private readonly storage: Storage;
  private readonly config: BrokerConfig;
  private readonly sessionManager: SessionManager;
  private readonly forkManager: ForkManager;
  private readonly summaryEngine: SummaryEngine;
  private server: Server | null = null;
  private startedAt: number = 0;
  private assignedPort: number = 0;
  private stopping: boolean = false;
  private idleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private shutdownCallback: (() => void) | null = null;

  constructor(storage: Storage, config?: Partial<BrokerConfig>, deps?: BrokerDeps) {
    this.storage = storage;
    this.config = { ...DEFAULT_BROKER_CONFIG, ...config };
    this.sessionManager = new SessionManager(storage);
    this.forkManager = new ForkManager(deps?.forker);
    this.summaryEngine = new SummaryEngine(
      storage,
      deps?.summaryGenerate,
      deps?.summaryQuery,
      deps?.summaryEnrich
    );

    // Wire up summary cleanup on session deregister
    this.sessionManager.onDeregister((sessionId) => {
      this.summaryEngine.delete(sessionId).catch(() => {});
    });

    // Wire up reference counting
    this.sessionManager.onDeregister(() => this.checkSessionCount());
    this.sessionManager.onRegister(() => this.cancelIdleTimeout());
  }

  /**
   * Register a callback to be called when auto-shutdown is triggered
   * (idle timeout with no sessions). The broker does not call process.exit()
   * itself — the caller controls the exit.
   */
  onAutoShutdown(callback: () => void): void {
    this.shutdownCallback = callback;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Broker is already running");
    }

    await this.storage.initDirectories();

    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.startedAt = Date.now();
    this.stopping = false;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.assignedPort = addr.port;
        }
        resolve();
      });
      this.server!.on("error", reject);
    });

    await this.storage.write(BROKER_PID_FILE, String(process.pid));
    await this.storage.write(BROKER_PORT_FILE, String(this.assignedPort));
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.stopping = true;
    this.cancelIdleTimeout();

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.server = null;

    await this.storage.delete(BROKER_PID_FILE);
    await this.storage.delete(BROKER_PORT_FILE);
  }

  getStatus(): BrokerStatus {
    return {
      pid: process.pid,
      port: this.assignedPort,
      host: this.config.host,
      uptime: this.startedAt > 0 ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      status: this.stopping ? "stopping" : "ok",
      sessions: this.sessionManager.getSessionCount(),
    };
  }

  getPort(): number {
    return this.assignedPort;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getForkManager(): ForkManager {
    return this.forkManager;
  }

  getSummaryEngine(): SummaryEngine {
    return this.summaryEngine;
  }

  private checkSessionCount(): void {
    if (this.sessionManager.getSessionCount() === 0) {
      this.startIdleTimeout();
    }
  }

  private startIdleTimeout(): void {
    this.cancelIdleTimeout();
    this.idleTimeoutHandle = setTimeout(() => {
      if (this.sessionManager.getSessionCount() === 0) {
        this.shutdownCallback?.();
      }
    }, this.config.idleTimeoutMs);
  }

  private cancelIdleTimeout(): void {
    if (this.idleTimeoutHandle) {
      clearTimeout(this.idleTimeoutHandle);
      this.idleTimeoutHandle = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Health endpoint
    if (req.method === "GET" && path === "/health") {
      const status = this.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    // Shutdown endpoint
    if (path === "/shutdown") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Broker shutting down" }));
      setTimeout(() => this.shutdownCallback?.(), 100);
      return;
    }

    // Session routes
    if (path.startsWith("/sessions")) {
      handleSessionRoutes(req, res, url, this.sessionManager);
      return;
    }

    // Ask route
    if (path === "/ask") {
      handleAskRoute(req, res, this.sessionManager, this.forkManager, this.summaryEngine);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
}
