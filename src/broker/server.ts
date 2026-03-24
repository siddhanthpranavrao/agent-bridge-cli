import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { BROKER_PID_FILE, BROKER_PORT_FILE } from "../constants.ts";
import type { Storage } from "../storage/storage.ts";
import { SessionManager } from "../sessions/manager.ts";
import { handleSessionRoutes } from "../sessions/routes.ts";
import { ForkManager } from "../fork/manager.ts";
import { handleAskRoute } from "../fork/routes.ts";
import type { ForkerFn } from "../fork/types.ts";
import { DEFAULT_BROKER_CONFIG, type BrokerConfig, type BrokerStatus } from "./types.ts";

export class BrokerServer {
  private readonly storage: Storage;
  private readonly config: BrokerConfig;
  private readonly sessionManager: SessionManager;
  private readonly forkManager: ForkManager;
  private server: Server | null = null;
  private startedAt: number = 0;
  private assignedPort: number = 0;
  private stopping: boolean = false;

  constructor(storage: Storage, config?: Partial<BrokerConfig>, forker?: ForkerFn) {
    this.storage = storage;
    this.config = { ...DEFAULT_BROKER_CONFIG, ...config };
    this.sessionManager = new SessionManager(storage);
    this.forkManager = new ForkManager(forker);
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

    // Session routes
    if (path.startsWith("/sessions")) {
      handleSessionRoutes(req, res, url, this.sessionManager);
      return;
    }

    // Ask route
    if (path === "/ask") {
      handleAskRoute(req, res, this.sessionManager, this.forkManager);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
}
