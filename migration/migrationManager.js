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

const PARALLEL_WORKERS = parseInt(process.env.PARALLEL_WORKERS) || 5;
const limit = pLimit(PARALLEL_WORKERS);

async function startMigration() {
  // ── Setup ──────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "prod") {
    await initializeMigrationTable();
    logBuffer.startDrainLoop();
  }
  await retry(() => initializeIndex());

  // ── Load saved state ───────────────────────────────────────────────────────
  const saved        = loadProgress();
  const completedSet = new Set(saved.completedRanges || []);
  let totalSaved     = saved.totalSaved  || 0;
  let totalFailed    = saved.totalFailed || 0;

  // ── Compute OR restore range boundaries ───────────────────────────────────
  let ranges = saved.rangeBoundaries;
  if (!ranges || ranges.length === 0) {
    mainLogger.info('Computing cursor ranges from MySQL (one-time, will be cached)...');
    ranges = await computeCursorRanges(parseInt(process.env.BATCH_SIZE) || 2000);
    // Cache immediately so a crash after compute doesn't force a re-compute
    saveProgress({
      completedRanges: [],
      totalRanges:     ranges.length,
      totalSaved:      0,
      totalFailed:     0,
      rangeBoundaries: ranges,
    });
    mainLogger.info(`Cached ${ranges.length} range boundaries in progress file.`);
  } else {
    mainLogger.info(`Restored ${ranges.length} ranges from progress file. ${completedSet.size} already completed.`);
  }

  const pendingRanges = ranges.filter(r => !completedSet.has(r.index));
  mainLogger.info(
    `Starting parallel migration: ${pendingRanges.length} ranges pending | ` +
    `${completedSet.size} done | ${PARALLEL_WORKERS} parallel workers`
  );

  // ── Dispatch all ranges concurrently with p-limit ─────────────────────────
  //
  // Each worker independently:
  //   1. Fetches its own bounded slice from MySQL (no coordination needed)
  //   2. Bulk-indexes into OpenSearch
  //   3. Atomically marks itself done in the progress file
  //
  // On crash: restart from where you left off — completed ranges are skipped.
  // No data loss: ranges use inclusive toUcid bounds so nothing is missed.
  // No duplicates: upsert (_id) makes re-running safe.

  await Promise.all(
    pendingRanges.map(range =>
      limit(async () => {
        const rangeLabel = `Range #${range.index} [${range.fromUcid} → ${range.toUcid}]`;
        try {
          mainLogger.info(`${rangeLabel}: fetching...`);
          const docs = await retry(() => fetchRange(range.fromUcid, range.toUcid));

          if (!docs || docs.length === 0) {
            mainLogger.warn(`${rangeLabel}: 0 docs found — marking complete.`);
          } else {
            const { succeeded, failed } = await processBatch(docs, range.index);
            totalSaved  += succeeded;
            totalFailed += failed;
            const logMsg = `${rangeLabel}: ✅ ${succeeded}/${docs.length} saved` +
                           (failed > 0 ? ` | ⚠️  ${failed} → DLQ` : '') +
                           ` | Progress: ${completedSet.size + 1}/${ranges.length}`;
            mainLogger.info(logMsg);

            // Record Sentry breadcrumb for local context
            addBreadcrumb("migration", logMsg, "info", { rangeIndex: range.index, succeeded, failed });
          }

          // Mark range complete and persist atomically
          completedSet.add(range.index);
          saveProgress({
            completedRanges: Array.from(completedSet),
            totalRanges:     ranges.length,
            totalSaved,
            totalFailed,
            rangeBoundaries: ranges,
          });

        } catch (err) {
          // Range stays NOT in completedSet → will be retried on next run
          mainLogger.error(`${rangeLabel} FAILED — will retry on restart. Error: ${err.message}`);
          captureException(err, {
            tags: { process: "migrationManager.js", phase: "range-processing", rangeIndex: range.index },
            extra: { rangeLabel, range }
          });
        }
      })
    )
  );

  // ── Final flush & summary ──────────────────────────────────────────────────
  if (process.env.NODE_ENV === "prod") {
    await logBuffer.flush();
  }

  const failedRanges = ranges.filter(r => !completedSet.has(r.index));
  const dlqCount     = dlq.count();

  mainLogger.info('════════════════════════════════════════');
  mainLogger.info('  MIGRATION COMPLETE');
  mainLogger.info('════════════════════════════════════════');
  mainLogger.info(`  Ranges completed : ${completedSet.size} / ${ranges.length}`);
  mainLogger.info(`  Docs saved       : ${totalSaved.toLocaleString()}`);
  mainLogger.info(`  Docs failed      : ${totalFailed.toLocaleString()}`);
  mainLogger.info(`  DLQ entries      : ${dlqCount}`);

  if (failedRanges.length > 0) {
    mainLogger.warn(`  ⚠️  ${failedRanges.length} ranges incomplete — run again to retry.`);
    captureMessage(`Migration completed with ${failedRanges.length} incomplete ranges`, "warning", {
      extra: { completedSetCount: completedSet.size, totalRangesCount: ranges.length, totalSaved, totalFailed, dlqCount }
    });
  }
  if (dlqCount > 0) {
    mainLogger.warn(`  ⚠️  ${dlqCount} docs in DLQ — run: node replay-failed.js`);
  }
  mainLogger.info('════════════════════════════════════════');
}

module.exports = startMigration;
