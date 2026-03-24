import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_SHUTDOWN_GRACE_MS } from "../constants.ts";

export interface BrokerConfig {
  /** Port to listen on. 0 = random available port (default). */
  port: number;
  /** Host to bind to. Default: "127.0.0.1" (localhost only). */
  host: string;
  /** Time in ms to wait after last session disconnects before auto-shutdown. Default: 30 min. */
  idleTimeoutMs: number;
  /** Grace period in ms before server closes, allowing in-flight requests to finish. Default: 5s. */
  shutdownGracePeriodMs: number;
}

export interface BrokerStatus {
  pid: number;
  port: number;
  host: string;
  uptime: number;
  status: "ok" | "stopping";
  sessions: number;
}

export interface BrokerDetailedStatus extends BrokerStatus {
  groups: {
    name: string;
    sessionCount: number;
    sessions: { name: string; sessionId: string; alive: boolean }[];
  }[];
  activeForks: number;
  summaries: number;
}

export const DEFAULT_BROKER_CONFIG: BrokerConfig = {
  port: 0,
  host: "127.0.0.1",
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  shutdownGracePeriodMs: DEFAULT_SHUTDOWN_GRACE_MS,
};
