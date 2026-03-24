import { BROKER_PID_FILE, BROKER_PORT_FILE, SUMMARIES_DIR } from "../constants.ts";
import type { Storage } from "../storage/storage.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { SummaryEngine } from "../summary/engine.ts";

export interface RecoveryResult {
  wasCrash: boolean;
  sessionsLoaded: number;
  sessionsRemoved: number;
  summariesCleaned: number;
}

export async function recoverFromCrash(
  storage: Storage,
  sessionManager: SessionManager,
  summaryEngine: SummaryEngine
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    wasCrash: false,
    sessionsLoaded: 0,
    sessionsRemoved: 0,
    summariesCleaned: 0,
  };

  // 1. Check for stale PID file
  const pidContent = await storage.read(BROKER_PID_FILE);
  if (!pidContent) {
    return result; // Clean start, no recovery needed
  }

  const oldPid = parseInt(pidContent, 10);
  if (isNaN(oldPid)) {
    // Corrupted PID file — clean up
    await storage.delete(BROKER_PID_FILE);
    await storage.delete(BROKER_PORT_FILE);
    return result;
  }

  // Check if old process is still running
  try {
    process.kill(oldPid, 0);
    // Process is alive — broker is already running
    throw new Error(`Broker is already running (PID: ${oldPid})`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("already running")) {
      throw err;
    }
    // Process is dead — previous crash detected
  }

  result.wasCrash = true;

  // 2. Clean stale PID/port files
  await storage.delete(BROKER_PID_FILE);
  await storage.delete(BROKER_PORT_FILE);

  // 3. Load persisted sessions from disk
  result.sessionsLoaded = await sessionManager.loadFromDisk();

  // 4. Validate PIDs and remove dead sessions
  result.sessionsRemoved = await sessionManager.cleanupDead();

  // 5. Clean orphaned summaries
  result.summariesCleaned = await cleanOrphanedSummaries(
    storage,
    sessionManager,
    summaryEngine
  );

  return result;
}

async function cleanOrphanedSummaries(
  storage: Storage,
  sessionManager: SessionManager,
  summaryEngine: SummaryEngine
): Promise<number> {
  let cleaned = 0;

  const summaryFiles = await storage.listDir(SUMMARIES_DIR);
  for (const file of summaryFiles) {
    if (!file.endsWith(".json")) continue;

    const sessionId = file.replace(".json", "");
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      await summaryEngine.delete(sessionId);
      cleaned++;
    }
  }

  return cleaned;
}
