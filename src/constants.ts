import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_DIR = join(homedir(), ".agent-bridge");
export const BROKER_PID_FILE = "broker.pid";
export const BROKER_PORT_FILE = "broker.port";
export const GROUPS_DIR = "groups";
export const SUMMARIES_DIR = "summaries";
