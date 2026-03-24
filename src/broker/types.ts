export interface BrokerConfig {
  /** Port to listen on. 0 = random available port (default). */
  port: number;
  /** Host to bind to. Default: "127.0.0.1" (localhost only). */
  host: string;
}

export interface BrokerStatus {
  pid: number;
  port: number;
  host: string;
  uptime: number;
  status: "ok" | "stopping";
  sessions: number;
}

export const DEFAULT_BROKER_CONFIG: BrokerConfig = {
  port: 0,
  host: "127.0.0.1",
};
