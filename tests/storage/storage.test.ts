import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage.ts";

let testDir: string;
let storage: Storage;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-test-"));
  storage = new Storage({ baseDir: testDir });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("Storage - path scoping", () => {
  test("allows valid relative paths", () => {
    const resolved = storage.ensureScoped("groups/acme/sessions.json");
    expect(resolved).toBe(join(testDir, "groups/acme/sessions.json"));
  });

  test("allows nested paths", () => {
    const resolved = storage.ensureScoped("summaries/s1.json");
    expect(resolved).toBe(join(testDir, "summaries/s1.json"));
  });

  test("rejects path traversal with ../", () => {
    expect(() => storage.ensureScoped("../etc/passwd")).toThrow("Path traversal detected");
  });

  test("rejects path traversal with ../../", () => {
    expect(() => storage.ensureScoped("../../etc/passwd")).toThrow("Path traversal detected");
  });

  test("rejects path traversal with nested escape", () => {
    expect(() => storage.ensureScoped("groups/../../etc/passwd")).toThrow("Path traversal detected");
  });

  test("rejects absolute paths outside base", () => {
    expect(() => storage.ensureScoped("/etc/passwd")).toThrow("Path traversal detected");
  });

  test("allows the base directory itself", () => {
    const resolved = storage.ensureScoped(".");
    expect(resolved).toBe(testDir);
  });

  test("empty string resolves to base directory", () => {
    const resolved = storage.ensureScoped("");
    expect(resolved).toBe(testDir);
  });

  test("rejects path with encoded traversal", () => {
    // Even if someone tries a tricky path that resolves outside
    expect(() => storage.ensureScoped("groups/../../../etc/passwd")).toThrow(
      "Path traversal detected"
    );
  });
});

describe("Storage - read/write/delete", () => {
  test("write and read a file", async () => {
    await storage.write("test.txt", "hello world");
    const content = await storage.read("test.txt");
    expect(content).toBe("hello world");
  });

  test("read returns null for non-existent file", async () => {
    const content = await storage.read("does-not-exist.txt");
    expect(content).toBeNull();
  });

  test("write creates parent directories", async () => {
    await storage.write("deep/nested/dir/file.json", '{"key": "value"}');
    const content = await storage.read("deep/nested/dir/file.json");
    expect(content).toBe('{"key": "value"}');
  });

  test("delete removes a file", async () => {
    await storage.write("to-delete.txt", "temp");
    expect(await storage.exists("to-delete.txt")).toBe(true);
    await storage.delete("to-delete.txt");
    expect(await storage.exists("to-delete.txt")).toBe(false);
  });

  test("delete is a no-op for non-existent file", async () => {
    // Should not throw
    await storage.delete("does-not-exist.txt");
  });

  test("write overwrites existing file with new content", async () => {
    await storage.write("overwrite.txt", "original");
    await storage.write("overwrite.txt", "updated");
    const content = await storage.read("overwrite.txt");
    expect(content).toBe("updated");
  });

  test("read throws on a directory path", async () => {
    await storage.ensureDir("some-dir");
    expect(storage.read("some-dir")).rejects.toThrow();
  });

  test("delete throws on a directory path", async () => {
    await storage.ensureDir("some-dir");
    expect(storage.delete("some-dir")).rejects.toThrow();
  });

  test("write handles empty string content", async () => {
    await storage.write("empty.txt", "");
    const content = await storage.read("empty.txt");
    expect(content).toBe("");
  });

  test("write handles unicode content", async () => {
    const unicode = "Hello 你好 مرحبا 🌍";
    await storage.write("unicode.txt", unicode);
    const content = await storage.read("unicode.txt");
    expect(content).toBe(unicode);
  });

  test("write handles large content", async () => {
    const large = "x".repeat(1_000_000);
    await storage.write("large.txt", large);
    const content = await storage.read("large.txt");
    expect(content).toBe(large);
  });
});

describe("Storage - exists", () => {
  test("returns true for existing file", async () => {
    await storage.write("exists.txt", "data");
    expect(await storage.exists("exists.txt")).toBe(true);
  });

  test("returns false for non-existing file", async () => {
    expect(await storage.exists("nope.txt")).toBe(false);
  });
});

describe("Storage - initDirectories", () => {
  test("creates groups and summaries directories", async () => {
    await storage.initDirectories();
    expect(await storage.exists("groups")).toBe(true);
    expect(await storage.exists("summaries")).toBe(true);
  });

  test("is idempotent - can be called multiple times", async () => {
    await storage.initDirectories();
    await storage.initDirectories();
    expect(await storage.exists("groups")).toBe(true);
    expect(await storage.exists("summaries")).toBe(true);
  });
});

describe("Storage - deleteAll", () => {
  test("removes the entire base directory", async () => {
    await storage.initDirectories();
    await storage.write("test.txt", "data");

    await storage.deleteAll();

    // Base directory should no longer exist
    let exists = true;
    try {
      await access(testDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("is no-op if directory doesn't exist", async () => {
    const nonexistentDir = join(tmpdir(), "agent-bridge-nonexistent-" + Date.now());
    const s = new Storage({ baseDir: nonexistentDir });

    // Should not throw
    await s.deleteAll();
  });
});
