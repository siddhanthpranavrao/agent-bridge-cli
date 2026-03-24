import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage.ts";
import { BrokerServer } from "../../src/broker/server.ts";

let testDir: string;
let storage: Storage;
let broker: BrokerServer;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-broker-test-"));
  storage = new Storage({ baseDir: testDir });
  broker = new BrokerServer(storage);
});

afterEach(async () => {
  try {
    await broker.stop();
  } catch {
    // Already stopped
  }
  await rm(testDir, { recursive: true, force: true });
});

describe("BrokerServer - lifecycle", () => {
  test("starts and assigns a port", async () => {
    await broker.start();
    const port = broker.getPort();
    expect(port).toBeGreaterThan(0);
  });

  test("writes PID and port files on start", async () => {
    await broker.start();
    const pidContent = await storage.read("broker.pid");
    const portContent = await storage.read("broker.port");

    expect(pidContent).toBe(String(process.pid));
    expect(portContent).toBe(String(broker.getPort()));
  });

  test("cleans up PID and port files on stop", async () => {
    await broker.start();
    await broker.stop();

    expect(await storage.exists("broker.pid")).toBe(false);
    expect(await storage.exists("broker.port")).toBe(false);
  });

  test("creates directory structure on start", async () => {
    await broker.start();
    expect(await storage.exists("groups")).toBe(true);
    expect(await storage.exists("summaries")).toBe(true);
  });

  test("throws if started twice", async () => {
    await broker.start();
    expect(broker.start()).rejects.toThrow("Broker is already running");
  });

  test("stop is safe to call when not running", async () => {
    // Should not throw
    await broker.stop();
  });
});

describe("BrokerServer - health endpoint", () => {
  test("returns 200 with status info", async () => {
    await broker.start();
    const port = broker.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(port);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("BrokerServer - unknown routes", () => {
  test("returns 404 for unknown paths", async () => {
    await broker.start();
    const port = broker.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);

    const body = await res.json() as any;
    expect(body.error).toBe("Not found");
  });
});

describe("BrokerServer - getStatus", () => {
  test("returns status with correct fields", async () => {
    await broker.start();
    const status = broker.getStatus();

    expect(status.pid).toBe(process.pid);
    expect(status.port).toBeGreaterThan(0);
    expect(status.host).toBe("127.0.0.1");
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.status).toBe("ok");
  });
});

describe("BrokerServer - negative scenarios", () => {
  test("POST to /health returns 404", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("PUT to /health returns 404", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "PUT" });
    expect(res.status).toBe(404);
  });

  test("DELETE to /health returns 404", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("concurrent health requests all succeed", async () => {
    await broker.start();
    const port = broker.getPort();

    const requests = Array.from({ length: 10 }, () =>
      fetch(`http://127.0.0.1:${port}/health`)
    );
    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe("ok");
    }
  });

  test("request after stop rejects connection", async () => {
    await broker.start();
    const port = broker.getPort();
    await broker.stop();

    expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

describe("BrokerServer - custom configuration", () => {
  test("respects custom port", async () => {
    // Use a high port to avoid conflicts
    const customBroker = new BrokerServer(storage, { port: 0 });
    await customBroker.start();
    const port = customBroker.getPort();
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await customBroker.stop();
  });

  test("respects custom host in status", async () => {
    const customBroker = new BrokerServer(storage, { host: "127.0.0.1" });
    await customBroker.start();
    const status = customBroker.getStatus();
    expect(status.host).toBe("127.0.0.1");
    await customBroker.stop();
  });

  test("status before start returns zero uptime", () => {
    const status = broker.getStatus();
    expect(status.uptime).toBe(0);
    expect(status.port).toBe(0);
  });
});

describe("BrokerServer - idle timeout and auto-shutdown", () => {
  test("triggers auto-shutdown callback after idle timeout with no sessions", async () => {
    let shutdownCalled = false;
    const shortBroker = new BrokerServer(storage, { idleTimeoutMs: 100 });
    shortBroker.onAutoShutdown(() => { shutdownCalled = true; });
    await shortBroker.start();
    const port = shortBroker.getPort();

    // Register and deregister a session to trigger ref counting
    await fetch(`http://127.0.0.1:${port}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1",
        pid: process.pid, workingDirectory: "/projects/test",
      }),
    });
    await fetch(`http://127.0.0.1:${port}/sessions/deregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 200));
    expect(shutdownCalled).toBe(true);

    await shortBroker.stop();
  });

  test("cancels idle timeout when new session registers", async () => {
    let shutdownCalled = false;
    const shortBroker = new BrokerServer(storage, { idleTimeoutMs: 150 });
    shortBroker.onAutoShutdown(() => { shutdownCalled = true; });
    await shortBroker.start();
    const port = shortBroker.getPort();

    // Register and deregister to start idle timer
    await fetch(`http://127.0.0.1:${port}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1",
        pid: process.pid, workingDirectory: "/projects/test",
      }),
    });
    await fetch(`http://127.0.0.1:${port}/sessions/deregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });

    // Register new session before timeout fires
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${port}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "uuid-2",
        pid: process.pid, workingDirectory: "/projects/other",
      }),
    });

    // Wait past what would have been the timeout
    await new Promise((r) => setTimeout(r, 200));
    expect(shutdownCalled).toBe(false); // should NOT have shut down

    await shortBroker.stop();
  });
});

describe("BrokerServer - manual shutdown endpoint", () => {
  test("POST /shutdown returns 200 and triggers callback", async () => {
    let shutdownCalled = false;
    await broker.start();
    broker.onAutoShutdown(() => { shutdownCalled = true; });
    const port = broker.getPort();

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.message).toContain("shutting down");

    await new Promise((r) => setTimeout(r, 200));
    expect(shutdownCalled).toBe(true);
  });

  test("GET /shutdown returns 405", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`);
    expect(res.status).toBe(405);
  });
});

describe("BrokerServer - status endpoint", () => {
  test("GET /status returns 200 with detailed info", async () => {
    await broker.start();
    const port = broker.getPort();

    // Register a session
    await fetch(`http://127.0.0.1:${port}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1",
        pid: process.pid, workingDirectory: "/projects/test", group: "acme",
      }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.pid).toBe(process.pid);
    expect(body.status).toBe("ok");
    expect(body.sessions).toBe(1);
    expect(body.groups).toBeDefined();
    expect(body.groups.length).toBe(1);
    expect(body.groups[0].name).toBe("acme");
    expect(body.groups[0].sessionCount).toBe(1);
    expect(body.groups[0].sessions[0].name).toBe("test");
    expect(body.groups[0].sessions[0].alive).toBe(true);
    expect(typeof body.activeForks).toBe("number");
    expect(typeof body.summaries).toBe("number");
  });

  test("POST /status returns 405", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/status`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("status with no sessions shows empty groups", async () => {
    await broker.start();
    const port = broker.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    const body = await res.json() as any;
    expect(body.groups).toEqual([]);
    expect(body.sessions).toBe(0);
  });
});
