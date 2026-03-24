import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage.ts";
import { SessionManager } from "../../src/sessions/manager.ts";

let testDir: string;
let storage: Storage;
let manager: SessionManager;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-sessions-test-"));
  storage = new Storage({ baseDir: testDir });
  await storage.initDirectories();
  manager = new SessionManager(storage);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("SessionManager - registration (happy path)", () => {
  test("registers a session with correct fields", async () => {
    const session = await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });

    expect(session.sessionId).toBe("s1");
    expect(session.pid).toBe(process.pid);
    expect(session.workingDirectory).toBe("/projects/frontend");
    expect(session.group).toBe("acme");
    expect(session.name).toBe("frontend");
    expect(typeof session.connectedAt).toBe("number");
  });

  test("uses default group when none specified", async () => {
    const session = await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/backend",
    });

    expect(session.group).toBe("default");
  });

  test("uses custom name when provided", async () => {
    const session = await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      name: "my-backend",
    });

    expect(session.name).toBe("my-backend");
  });

  test("auto-derives name from working directory basename", async () => {
    const session = await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/home/user/projects/hermes-svc",
    });

    expect(session.name).toBe("hermes-svc");
  });

  test("registers multiple sessions in same group", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
    });

    const sessions = manager.listByGroup("acme");
    expect(sessions.length).toBe(2);
  });

  test("registers sessions in different groups", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/sideproject",
      group: "personal",
    });

    expect(manager.listByGroup("acme").length).toBe(1);
    expect(manager.listByGroup("personal").length).toBe(1);
  });
});

describe("SessionManager - registration (negative)", () => {
  test("rejects duplicate sessionId", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    expect(
      manager.register({
        sessionId: "s1",
        pid: process.pid,
        workingDirectory: "/projects/backend",
      })
    ).rejects.toThrow("already registered");
  });

  test("rejects invalid PID (0)", async () => {
    expect(
      manager.register({
        sessionId: "s1",
        pid: 0,
        workingDirectory: "/projects/frontend",
      })
    ).rejects.toThrow();
  });

  test("rejects negative PID", async () => {
    expect(
      manager.register({
        sessionId: "s1",
        pid: -1,
        workingDirectory: "/projects/frontend",
      })
    ).rejects.toThrow();
  });

  test("rejects empty sessionId", async () => {
    expect(
      manager.register({
        sessionId: "",
        pid: process.pid,
        workingDirectory: "/projects/frontend",
      })
    ).rejects.toThrow();
  });

  test("rejects empty workingDirectory", async () => {
    expect(
      manager.register({
        sessionId: "s1",
        pid: process.pid,
        workingDirectory: "",
      })
    ).rejects.toThrow();
  });
});

describe("SessionManager - deregistration", () => {
  test("deregisters existing session", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    const result = await manager.deregister("s1");
    expect(result).toBe(true);
    expect(manager.getSession("s1")).toBeNull();
  });

  test("returns false for non-existent session", async () => {
    const result = await manager.deregister("nonexistent");
    expect(result).toBe(false);
  });

  test("cleans up group when last session is removed", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });

    await manager.deregister("s1");
    expect(manager.listAllGroups()).not.toContain("acme");
  });

  test("group persists when other sessions remain", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
    });

    await manager.deregister("s1");
    expect(manager.listAllGroups()).toContain("acme");
    expect(manager.listByGroup("acme").length).toBe(1);
  });
});

describe("SessionManager - listing", () => {
  test("lists sessions in a group", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
    });

    const sessions = manager.listByGroup("acme");
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => s.sessionId)).toContain("s1");
    expect(sessions.map((s) => s.sessionId)).toContain("s2");
  });

  test("returns empty array for non-existent group", () => {
    const sessions = manager.listByGroup("nonexistent");
    expect(sessions).toEqual([]);
  });

  test("lists all groups", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/side",
      group: "personal",
    });

    const groups = manager.listAllGroups();
    expect(groups).toContain("acme");
    expect(groups).toContain("personal");
    expect(groups.length).toBe(2);
  });

  test("groups with no sessions are not listed", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.deregister("s1");

    expect(manager.listAllGroups()).not.toContain("acme");
  });

  test("different groups are isolated", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/side",
      group: "personal",
    });

    const acme = manager.listByGroup("acme");
    expect(acme.length).toBe(1);
    expect(acme[0]!.sessionId).toBe("s1");

    const personal = manager.listByGroup("personal");
    expect(personal.length).toBe(1);
    expect(personal[0]!.sessionId).toBe("s2");
  });
});

describe("SessionManager - resolve (fuzzy matching)", () => {
  beforeEach(async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
      name: "frontend",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
      name: "backend",
    });
  });

  test("resolves by exact sessionId", () => {
    const session = manager.resolve("s1", "acme");
    expect(session?.sessionId).toBe("s1");
  });

  test("resolves by exact name", () => {
    const session = manager.resolve("backend", "acme");
    expect(session?.sessionId).toBe("s2");
  });

  test("resolves by fuzzy name match", () => {
    const session = manager.resolve("bakend", "acme");
    expect(session?.sessionId).toBe("s2");
  });

  test("returns null for no match", () => {
    const session = manager.resolve("zzzzzzz", "acme");
    expect(session).toBeNull();
  });

  test("does not resolve across groups", () => {
    const session = manager.resolve("frontend", "nonexistent");
    expect(session).toBeNull();
  });

  test("resolves case-insensitively", () => {
    const session = manager.resolve("FRONTEND", "acme");
    expect(session?.sessionId).toBe("s1");
  });
});

describe("SessionManager - PID validation", () => {
  test("current process PID is alive", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    expect(manager.validateAlive("s1")).toBe(true);
  });

  test("non-existent PID is dead", async () => {
    await manager.register({
      sessionId: "s1",
      pid: 99999999,
      workingDirectory: "/projects/frontend",
    });

    expect(manager.validateAlive("s1")).toBe(false);
  });

  test("non-existent session returns false", () => {
    expect(manager.validateAlive("nonexistent")).toBe(false);
  });

  test("cleanupDead removes dead sessions", async () => {
    await manager.register({
      sessionId: "alive",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });
    await manager.register({
      sessionId: "dead",
      pid: 99999999,
      workingDirectory: "/projects/backend",
    });

    const removed = await manager.cleanupDead();
    expect(removed).toBe(1);
    expect(manager.getSession("alive")).not.toBeNull();
    expect(manager.getSession("dead")).toBeNull();
  });

  test("cleanupDead returns 0 when all alive", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    const removed = await manager.cleanupDead();
    expect(removed).toBe(0);
  });
});

describe("SessionManager - persistence", () => {
  test("sessions.json exists after registration", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });

    expect(await storage.exists("groups/acme/sessions.json")).toBe(true);
  });

  test("sessions.json is updated after deregistration", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
    });
    await manager.deregister("s1");

    const content = await storage.read("groups/acme/sessions.json");
    const persisted = JSON.parse(content!);
    expect(persisted.length).toBe(1);
    expect(persisted[0].sessionId).toBe("s2");
  });

  test("sessions.json is removed when group is empty", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await manager.deregister("s1");

    expect(await storage.exists("groups/acme/sessions.json")).toBe(false);
  });

  test("persisted data matches in-memory state", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
      name: "my-frontend",
    });

    const content = await storage.read("groups/acme/sessions.json");
    const persisted = JSON.parse(content!);
    const inMemory = manager.listByGroup("acme");

    expect(persisted.length).toBe(inMemory.length);
    expect(persisted[0].sessionId).toBe(inMemory[0]!.sessionId);
    expect(persisted[0].name).toBe(inMemory[0]!.name);
    expect(persisted[0].group).toBe(inMemory[0]!.group);
  });
});

describe("SessionManager - getSessionCount", () => {
  test("returns 0 when empty", () => {
    expect(manager.getSessionCount()).toBe(0);
  });

  test("returns correct count after registrations", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/a",
    });
    await manager.register({
      sessionId: "s2",
      pid: process.pid,
      workingDirectory: "/projects/b",
    });

    expect(manager.getSessionCount()).toBe(2);
  });

  test("decrements after deregistration", async () => {
    await manager.register({
      sessionId: "s1",
      pid: process.pid,
      workingDirectory: "/projects/a",
    });
    await manager.deregister("s1");

    expect(manager.getSessionCount()).toBe(0);
  });
});
