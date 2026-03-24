import { basename } from "node:path";
import { GROUPS_DIR, DEFAULT_GROUP_NAME, SESSIONS_FILE } from "../constants.ts";
import type { Storage } from "../storage/storage.ts";
import { RegisterRequestSchema, SessionSchema, type Session, type RegisterRequest } from "./types.ts";
import { fuzzyMatch } from "../utils/fuzzy.ts";

/**
 * Sanitize a session name to be CLI-friendly:
 * lowercase, alphanumeric + hyphens only, no spaces or special chars.
 */
function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")   // replace non-alphanumeric (except hyphen) with hyphen
    .replace(/-+/g, "-")            // collapse multiple hyphens
    .replace(/^-|-$/g, "")          // trim leading/trailing hyphens
    || "unnamed";                   // fallback if empty after sanitization
}

export class SessionManager {
  private readonly storage: Storage;
  private readonly sessions: Map<string, Session> = new Map();
  private readonly groupIndex: Map<string, Set<string>> = new Map();
  private readonly onRegisterCallbacks: ((sessionId: string) => void)[] = [];
  private readonly onDeregisterCallbacks: ((sessionId: string, claudeSessionId: string) => void)[] = [];

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async register(request: RegisterRequest): Promise<Session> {
    const parsed = RegisterRequestSchema.parse(request);

    if (this.sessions.has(parsed.sessionId)) {
      throw new Error(`Session "${parsed.sessionId}" is already registered`);
    }

    const group = parsed.group ?? DEFAULT_GROUP_NAME;
    const rawName = parsed.name ?? basename(parsed.workingDirectory);
    const name = this.uniquifyName(sanitizeName(rawName), group);

    const session: Session = SessionSchema.parse({
      sessionId: parsed.sessionId,
      claudeSessionId: parsed.claudeSessionId,
      pid: parsed.pid,
      workingDirectory: parsed.workingDirectory,
      group,
      name,
      connectedAt: Date.now(),
    });

    this.sessions.set(session.sessionId, session);

    if (!this.groupIndex.has(group)) {
      this.groupIndex.set(group, new Set());
    }
    this.groupIndex.get(group)!.add(session.sessionId);

    await this.persistGroup(group);

    for (const cb of this.onRegisterCallbacks) {
      try { cb(session.sessionId); } catch {}
    }

    return session;
  }

  async deregister(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const group = session.group;
    this.sessions.delete(sessionId);

    for (const cb of this.onDeregisterCallbacks) {
      try { cb(sessionId, session.claudeSessionId); } catch { /* don't let callback errors break deregistration */ }
    }

    const groupSessions = this.groupIndex.get(group);
    if (groupSessions) {
      groupSessions.delete(sessionId);
      if (groupSessions.size === 0) {
        this.groupIndex.delete(group);
        await this.removeGroupFile(group);
        return true;
      }
    }

    await this.persistGroup(group);
    return true;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  listByGroup(group: string): Session[] {
    const sessionIds = this.groupIndex.get(group);
    if (!sessionIds) {
      return [];
    }

    return Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  listAllGroups(): string[] {
    return Array.from(this.groupIndex.keys());
  }

  resolve(nameOrId: string, group: string): Session | null {
    // 1. Exact sessionId match (any group)
    const byId = this.sessions.get(nameOrId);
    if (byId && byId.group === group) {
      return byId;
    }

    const groupSessions = this.listByGroup(group);
    if (groupSessions.length === 0) {
      return null;
    }

    // 2. Exact name match
    const byName = groupSessions.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
    if (byName) {
      return byName;
    }

    // 3. Fuzzy name match
    const names = groupSessions.map((s) => s.name);
    const matched = fuzzyMatch(nameOrId, names);
    if (matched) {
      return groupSessions.find((s) => s.name.toLowerCase() === matched.toLowerCase()) ?? null;
    }

    return null;
  }

  validateAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      process.kill(session.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupDead(): Promise<number> {
    let removed = 0;
    const allSessionIds = Array.from(this.sessions.keys());

    for (const sessionId of allSessionIds) {
      if (!this.validateAlive(sessionId)) {
        await this.deregister(sessionId);
        removed++;
      }
    }

    return removed;
  }

  onRegister(callback: (sessionId: string) => void): void {
    this.onRegisterCallbacks.push(callback);
  }

  onDeregister(callback: (sessionId: string, claudeSessionId: string) => void): void {
    this.onDeregisterCallbacks.push(callback);
  }

  /**
   * Reload sessions from persisted group files on disk.
   * Used for crash recovery — restores in-memory state from persistent storage.
   */
  async loadFromDisk(): Promise<number> {
    const { z } = await import("zod");
    let loaded = 0;

    const groupDirs = await this.storage.listDir(GROUPS_DIR);
    for (const groupDir of groupDirs) {
      const content = await this.storage.read(`${GROUPS_DIR}/${groupDir}/${SESSIONS_FILE}`);
      if (!content) continue;

      try {
        const sessions = z.array(SessionSchema).parse(JSON.parse(content));
        for (const session of sessions) {
          if (this.sessions.has(session.sessionId)) continue;
          this.sessions.set(session.sessionId, session);

          if (!this.groupIndex.has(session.group)) {
            this.groupIndex.set(session.group, new Set());
          }
          this.groupIndex.get(session.group)!.add(session.sessionId);
          loaded++;
        }
      } catch {
        // Skip corrupted files
      }
    }

    return loaded;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * If a name already exists in the group, auto-suffix with -2, -3, etc.
   */
  private uniquifyName(name: string, group: string): string {
    const groupSessions = this.listByGroup(group);
    const existingNames = new Set(groupSessions.map((s) => s.name.toLowerCase()));

    if (!existingNames.has(name.toLowerCase())) {
      return name;
    }

    let suffix = 2;
    while (existingNames.has(`${name}-${suffix}`)) {
      suffix++;
    }
    return `${name}-${suffix}`;
  }

  private groupFilePath(group: string): string {
    return `${GROUPS_DIR}/${group}/${SESSIONS_FILE}`;
  }

  private async persistGroup(group: string): Promise<void> {
    const sessions = this.listByGroup(group);
    await this.storage.write(this.groupFilePath(group), JSON.stringify(sessions, null, 2));
  }

  private async removeGroupFile(group: string): Promise<void> {
    await this.storage.delete(this.groupFilePath(group));
  }
}
