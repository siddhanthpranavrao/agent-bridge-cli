#!/usr/bin/env node

import { Storage } from "./storage/storage.ts";
import { BrokerServer } from "./broker/server.ts";
import { recoverFromCrash } from "./broker/recovery.ts";
import { BROKER_PID_FILE, BROKER_PORT_FILE } from "./constants.ts";

const args = process.argv.slice(2);

// Handle CLI commands
if (args[0] === "--shutdown" || args[0] === "stop") {
  const storage = new Storage();
  const port = await storage.read(BROKER_PORT_FILE);
  if (!port) {
    console.log("Broker is not running.");
    process.exit(0);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port.trim()}/shutdown`, { method: "POST" });
    if (res.ok) {
      console.log("Broker shutdown requested.");
    } else {
      console.error("Failed to shutdown broker.");
    }
  } catch {
    console.error("Could not connect to broker. It may already be stopped.");
    // Clean up stale files
    await storage.delete(BROKER_PID_FILE);
    await storage.delete(BROKER_PORT_FILE);
    console.log("Cleaned up stale files.");
  }
  process.exit(0);
}

if (args[0] === "--status" || args[0] === "status") {
  const storage = new Storage();
  const port = await storage.read(BROKER_PORT_FILE);
  if (!port) {
    console.log("Broker is not running.");
    process.exit(0);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port.trim()}/status`);
    const status = await res.json();
    console.log(JSON.stringify(status, null, 2));
  } catch {
    console.log("Could not connect to broker. It may not be running.");
  }
  process.exit(0);
}

if (args[0] === "--help" || args[0] === "help" || args[0] === "-h") {
  console.log(`agent-bridge — Cross-session communication for Claude Code

Usage:
  agent-bridge              Start the broker
  agent-bridge stop         Stop the broker
  agent-bridge status       Show broker status
  agent-bridge help         Show this help message`);
  process.exit(0);
}

// Default: start the broker
async function main() {
  const storage = new Storage();
  const broker = new BrokerServer(storage);

  // Crash recovery
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

  broker.onAutoShutdown(async () => {
    console.log("\nAll sessions disconnected. Shutting down broker...");
    await broker.stop();
    console.log("Broker stopped.");
    process.exit(0);
  });

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
