#!/usr/bin/env node

import { Storage } from "./storage/storage.ts";
import { BrokerServer } from "./broker/server.ts";

async function main() {
  const storage = new Storage();
  const broker = new BrokerServer(storage);

  const shutdown = async () => {
    console.log("\nShutting down broker...");
    await broker.stop();
    console.log("Broker stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await broker.start();
  const status = broker.getStatus();
  console.log(`Broker started on port ${status.port} (PID: ${status.pid})`);
}

main().catch((err) => {
  console.error("Failed to start broker:", err);
  process.exit(1);
});
