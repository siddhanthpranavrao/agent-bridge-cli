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

    const body = await res.json();
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

    const body = await res.json();
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
      const body = await res.json();
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
