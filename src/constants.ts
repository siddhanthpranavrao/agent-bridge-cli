import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_DIR = join(homedir(), ".agent-bridge");
export const BROKER_PID_FILE = "broker.pid";
export const BROKER_PORT_FILE = "broker.port";
export const GROUPS_DIR = "groups";
export const SUMMARIES_DIR = "summaries";
export const DEFAULT_GROUP_NAME = "default";
export const SESSIONS_FILE = "sessions.json";
export const DEFAULT_FORK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_MAX_SUMMARY_ENTRIES = 100;
export const DEFAULT_MAX_ENTRY_SIZE_CHARS = 2000;
export const INSUFFICIENT_CONTEXT = "INSUFFICIENT_CONTEXT";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_SHUTDOWN_GRACE_MS = 5 * 1000; // 5 seconds
export const DEFAULT_FORK_TTL_MS = 15 * 60 * 1000; // 15 minutes
