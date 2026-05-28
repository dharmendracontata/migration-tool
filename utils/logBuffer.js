const { saveMigrationLogs } = require('../services/mySqlService');
const { mainLogger } = require('./logger');

// ─── ASYNC MIGRATION LOG BUFFER ──────────────────────────────────────────────
//
// Instead of blocking every worker on a MySQL INSERT, we collect log entries
// in memory and drain them to the DB in a background loop. This decouples the
// cursor-commit path from log persistence entirely.
//
// Usage:
//   logBuffer.startDrainLoop();
//   logBuffer.addLogs([...]);          // non-blocking
//   await logBuffer.flush();           // call at end of migration
//   logBuffer.stopDrainLoop();

const LOG_BATCH_SIZE = parseInt(process.env.LOG_BATCH_SIZE) || 500;
const DRAIN_INTERVAL_MS = 2000; // flush every 2 seconds in background

let buffer = [];
let draining = false;
let drainTimer = null;

/**
 * Add log entries to the in-memory buffer (non-blocking).
 * @param {Object[]} entries - Array of { ucid, status, whyfailed? }
 */
function addLogs(entries) {
  if (!entries || entries.length === 0) return;
  buffer.push(...entries);
}

/**
 * Internal: drain up to LOG_BATCH_SIZE entries from the buffer to MySQL.
 * Uses a mutex flag so concurrent drain calls don't double-write.
 */
async function _drain() {
  if (draining || buffer.length === 0) return;
  draining = true;

  try {
    while (buffer.length > 0) {
      const chunk = buffer.splice(0, LOG_BATCH_SIZE);
      try {
        await saveMigrationLogs(chunk);
        mainLogger.debug(`LogBuffer: flushed ${chunk.length} entries to migration_logs.`);
      } catch (err) {
        // Put failed entries back at front so they're retried on next drain cycle.
        buffer.unshift(...chunk);
        mainLogger.warn(`LogBuffer: drain failed, ${chunk.length} entries re-queued. Error: ${err.message}`);
        break; // stop draining this cycle; retry on next interval
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Start the background drain loop. Call once at migration start (prod only).
 */
function startDrainLoop() {
  if (drainTimer) return; // already running
  drainTimer = setInterval(() => {
    _drain().catch(err => mainLogger.warn(`LogBuffer drain loop error: ${err.message}`));
  }, DRAIN_INTERVAL_MS);

  // Prevent the timer from keeping the process alive after migration finishes.
  if (drainTimer.unref) drainTimer.unref();

  mainLogger.info(`LogBuffer: background drain loop started (interval=${DRAIN_INTERVAL_MS}ms, batchSize=${LOG_BATCH_SIZE}).`);
}

/**
 * Stop the background drain loop.
 */
function stopDrainLoop() {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

/**
 * Force-flush all remaining buffered entries to MySQL.
 * Call this after all workers have completed to ensure no logs are lost.
 */
async function flush() {
  stopDrainLoop();

  if (buffer.length === 0) {
    mainLogger.info('LogBuffer: flush called — buffer already empty.');
    return;
  }

  mainLogger.info(`LogBuffer: flushing ${buffer.length} remaining entries...`);
  await _drain();

  if (buffer.length > 0) {
    mainLogger.warn(`LogBuffer: ${buffer.length} entries could not be flushed after final drain.`);
  } else {
    mainLogger.info('LogBuffer: all entries flushed successfully.');
  }
}

/**
 * Returns the current buffer size (for monitoring/logging).
 */
function pendingCount() {
  return buffer.length;
}

module.exports = { addLogs, startDrainLoop, stopDrainLoop, flush, pendingCount };
