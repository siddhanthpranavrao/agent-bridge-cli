import { readFile, writeFile, unlink, mkdir, access, readdir, rm } from "node:fs/promises";
import { resolve, normalize } from "node:path";
import {
  DEFAULT_BASE_DIR,
  GROUPS_DIR,
  SUMMARIES_DIR,
} from "../constants.ts";
import type { StorageOptions } from "./types.ts";

export class Storage {
  private readonly baseDir: string;

  constructor(options?: Partial<StorageOptions>) {
    this.baseDir = resolve(options?.baseDir ?? DEFAULT_BASE_DIR);
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Validates that a resolved path is within the base directory.
   * Returns the resolved absolute path if valid, throws if not.
   */
  ensureScoped(relativePath: string): string {
    const resolved = resolve(this.baseDir, relativePath);
    const normalizedBase = normalize(this.baseDir);
    const normalizedResolved = normalize(resolved);

    if (
      !normalizedResolved.startsWith(normalizedBase + "/") &&
      normalizedResolved !== normalizedBase
    ) {
      throw new Error(
        `Path traversal detected: "${relativePath}" resolves outside base directory`
      );
    }

    return resolved;
  }

  async read(relativePath: string): Promise<string | null> {
    const fullPath = this.ensureScoped(relativePath);
    try {
      return await readFile(fullPath, "utf-8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async write(relativePath: string, data: string): Promise<void> {
    const fullPath = this.ensureScoped(relativePath);
    // Ensure parent directory exists
    const parentDir = resolve(fullPath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, data, "utf-8");
  }

  async delete(relativePath: string): Promise<void> {
    const fullPath = this.ensureScoped(relativePath);
    try {
      await unlink(fullPath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return; // Already gone, no-op
      }
      throw err;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const fullPath = this.ensureScoped(relativePath);
    try {
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    const fullPath = this.ensureScoped(relativePath);
    await mkdir(fullPath, { recursive: true });
  }

  async listDir(relativePath: string): Promise<string[]> {
    const fullPath = this.ensureScoped(relativePath);
    try {
      return await readdir(fullPath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async initDirectories(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await this.ensureDir(GROUPS_DIR);
    await this.ensureDir(SUMMARIES_DIR);
  }

  async deleteAll(): Promise<void> {
    await rm(this.baseDir, { recursive: true, force: true });
  }
}
