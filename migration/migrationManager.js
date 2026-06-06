const pLimit = require("p-limit");

const { computeCursorRanges, fetchRange, initializeMigrationTable } = require("../services/mySqlService");
const { initializeIndex } = require("../services/openSearchService");
const processBatch = require("./migrationWorker");
const { saveProgress, loadProgress } = require("../utils/progressStore");
const { mainLogger } = require("../utils/logger");
const logBuffer = require("../utils/logBuffer");
const dlq = require("../utils/deadLetterQueue");
const retry = require("../utils/retry");
const { captureException, captureMessage, addBreadcrumb } = require("../utils/sentry");

const PARALLEL_WORKERS  = parseInt(process.env.PARALLEL_WORKERS) || 5;
const RANGE_SAVE_INTERVAL = parseInt(process.env.RANGE_SAVE_INTERVAL) || 200; // flush every N ranges
const limit = pLimit(PARALLEL_WORKERS);

async function startMigration() {
  // ── Setup ──────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "prod") {
    await initializeMigrationTable();
    logBuffer.startDrainLoop();
  }
  await retry(() => initializeIndex());

  // ── Load saved state ───────────────────────────────────────────────────────
  const saved            = loadProgress();
  const completedSet     = new Set(saved.completedRanges || []);
  let   totalSaved       = saved.totalSaved       || 0;
  let   totalFailed      = saved.totalFailed      || 0;
  let   allRanges        = saved.rangeBoundaries  || [];   // grows as streaming progresses
  const streamingComplete = saved.streamingComplete === true;
  let   _streamingComplete = false;

  // ── Helper: persist current state ─────────────────────────────────────────
  // Called from both the streaming callback and worker completions.
  // Node.js is single-threaded so there are no real races; we write atomically.
  function persist(opts = {}) {
    saveProgress({
      completedRanges:   Array.from(completedSet),
      totalRanges:       allRanges.length,
      totalSaved,
      totalFailed,
      streamingComplete: opts.streamingComplete ?? streamingComplete,
      rangeBoundaries:   allRanges,
    }, opts.writeRanges ?? false);
  }

  // ── Helper: dispatch one range to a p-limited worker ──────────────────────
  let activeWorkers = 0;
  let resolveMigration;
  const migrationCompletionPromise = new Promise(resolve => {
    resolveMigration = resolve;
  });

  function dispatchRange(range) {
    activeWorkers++;
    limit(async () => {
      const rangeLabel = `Range #${range.index} [${range.fromUcid} → ${range.toUcid}]`;
      try {
        // Apply backpressure if log buffer is too full
        while (logBuffer.pendingCount() > 50000) {
          mainLogger.warn(`Log buffer size (${logBuffer.pendingCount()}) exceeds limit. Pausing range fetch to let log writer catch up...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        mainLogger.info(`${rangeLabel}: fetching...`);
        const docs = await retry(() => fetchRange(range.fromUcid, range.toUcid));

        if (!docs || docs.length === 0) {
          mainLogger.warn(`${rangeLabel}: 0 docs found — marking complete.`);
        } else {
          const { succeeded, failed } = await processBatch(docs, range.index);
          totalSaved  += succeeded;
          totalFailed += failed;
          const logMsg =
            `${rangeLabel}: ✅ ${succeeded}/${docs.length} saved` +
            (failed > 0 ? ` | ⚠️  ${failed} → DLQ` : "") +
            ` | Done: ${completedSet.size + 1}/${allRanges.length}`;
          mainLogger.info(logMsg);
          addBreadcrumb("migration", logMsg, "info", { rangeIndex: range.index, succeeded, failed });
        }

        completedSet.add(range.index);
        persist();

      } catch (err) {
        mainLogger.error(`${rangeLabel} FAILED — will retry on restart. Error: ${err.message}`);
        captureException(err, {
          tags:  { process: "migrationManager.js", phase: "range-processing", rangeIndex: range.index },
          extra: { rangeLabel, range },
        });
      } finally {
        activeWorkers--;
        if (activeWorkers === 0 && (streamingComplete || _streamingComplete)) {
          resolveMigration();
        }
      }
    });
  }

  // ── Phase 1: Streaming (with incremental save + immediate dispatch) ────────
  if (streamingComplete) {
    // ── Fast path: streaming already finished in a prior run ────────────────
    mainLogger.info(
      `Streaming already complete. ` +
      `${allRanges.length} ranges restored, ${completedSet.size} already done.`
    );
    const pending = allRanges.filter(r => !completedSet.has(r.index));
    if (pending.length === 0) {
      mainLogger.info("All ranges already completed. Nothing to migrate.");
      resolveMigration();
    } else {
      mainLogger.info(
        `Starting parallel migration: ${pending.length} pending | ` +
        `${completedSet.size} done | ${PARALLEL_WORKERS} workers`
      );
      pending.forEach(dispatchRange);
    }

  } else {
    // ── Resumable streaming path ──────────────────────────────────────────
    const resumeFromUcid = allRanges.length > 0
      ? allRanges[allRanges.length - 1].toUcid
      : null;
    const startIndex = allRanges.length;

    if (resumeFromUcid) {
      mainLogger.info(
        `Resuming range pre-computation from UCID: ${resumeFromUcid} ` +
        `(${allRanges.length} ranges already cached, ${completedSet.size} migrated)`
      );
    } else {
      mainLogger.info("Starting fresh range pre-computation (streaming all UCIDs)...");
    }

    // Dispatch any already-cached ranges that haven't been migrated yet
    // so migration runs in parallel with the stream from the very first second.
    const alreadyCached = allRanges.filter(r => !completedSet.has(r.index));
    if (alreadyCached.length > 0) {
      mainLogger.info(`Dispatching ${alreadyCached.length} cached-but-pending ranges immediately...`);
      alreadyCached.forEach(dispatchRange);
    }

    // Stream and receive new ranges in chunks
    await computeCursorRanges(
      parseInt(process.env.BATCH_SIZE) || 2000,
      {
        resumeFromUcid,
        startIndex,
        saveInterval: RANGE_SAVE_INTERVAL,

        onRangesReady(newRanges, isLast) {
          // Append to the in-memory list and persist immediately
          allRanges.push(...newRanges);

          if (isLast) {
            _streamingComplete = true;
            mainLogger.info(
              `✅ Streaming complete — total ranges: ${allRanges.length} ` +
              `(${completedSet.size} already migrated)`
            );
          } else {
            mainLogger.info(
              `Cached ${allRanges.length} ranges so far (${completedSet.size} migrated)...`
            );
          }

          // Persist to disk (streamingComplete flag written on final flush)
          saveProgress({
            completedRanges:   Array.from(completedSet),
            totalRanges:       allRanges.length,
            totalSaved,
            totalFailed,
            streamingComplete: _streamingComplete,
            rangeBoundaries:   allRanges,
          }, true);

          // Dispatch new ranges to workers immediately — no waiting!
          newRanges
            .filter(r => !completedSet.has(r.index))
            .forEach(dispatchRange);
        },
      }
    );
  }

  // ── Phase 2: Wait for all dispatched workers to finish ────────────────────
  if (activeWorkers > 0) {
    mainLogger.info(`Waiting for ${activeWorkers} active workers to complete...`);
    await migrationCompletionPromise;
  } else {
    mainLogger.info("No active workers to wait for.");
  }

  // ── Final flush & summary ──────────────────────────────────────────────────
  if (process.env.NODE_ENV === "prod") {
    await logBuffer.flush();
  }

  const failedRanges = allRanges.filter(r => !completedSet.has(r.index));
  const dlqCount     = dlq.count();

  mainLogger.info("════════════════════════════════════════");
  mainLogger.info("  MIGRATION COMPLETE");
  mainLogger.info("════════════════════════════════════════");
  mainLogger.info(`  Ranges completed : ${completedSet.size} / ${allRanges.length}`);
  mainLogger.info(`  Docs saved       : ${totalSaved.toLocaleString()}`);
  mainLogger.info(`  Docs failed      : ${totalFailed.toLocaleString()}`);
  mainLogger.info(`  DLQ entries      : ${dlqCount}`);

  if (failedRanges.length > 0) {
    mainLogger.warn(`  ⚠️  ${failedRanges.length} ranges incomplete — run again to retry.`);
    captureMessage(`Migration completed with ${failedRanges.length} incomplete ranges`, "warning", {
      extra: { completedSetCount: completedSet.size, totalRangesCount: allRanges.length, totalSaved, totalFailed, dlqCount },
    });
  }
  if (dlqCount > 0) {
    mainLogger.warn(`  ⚠️  ${dlqCount} docs in DLQ — run: node replay-failed.js`);
  }
  mainLogger.info("════════════════════════════════════════");
}

module.exports = startMigration;
