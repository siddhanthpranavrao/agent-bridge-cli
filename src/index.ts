#!/usr/bin/env node

import { Storage } from "./storage/storage.ts";
import { BrokerServer } from "./broker/server.ts";
import { recoverFromCrash } from "./broker/recovery.ts";

async function main() {
  const storage = new Storage();
  const broker = new BrokerServer(storage);

  // Crash recovery — check for stale PID, reload sessions, clean up
  const recovery = await recoverFromCrash(
    storage,
    broker.getSessionManager(),
    broker.getSummaryEngine()
  );

  if (recovery.wasCrash) {
    console.log(
      `Recovered from crash: ${recovery.sessionsLoaded} sessions loaded, ` +
        `${recovery.sessionsRemoved} dead removed, ` +
        `${recovery.summariesCleaned} orphaned summaries cleaned`
    );
  }

  // Auto-shutdown when all sessions disconnect after idle timeout
  broker.onAutoShutdown(async () => {
    console.log("\nAll sessions disconnected. Shutting down broker...");
    await broker.stop();
    console.log("Broker stopped.");
    process.exit(0);
  });

  // Signal handlers
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
