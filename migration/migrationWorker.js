const retry = require("../utils/retry");
const { bulkIndex } = require("../services/openSearchService");
const { migratedLogger, failedLogger, mainLogger, checkAndRotateLog } = require("../utils/logger");
const logBuffer = require("../utils/logBuffer");
const dlq = require("../utils/deadLetterQueue");
const { captureException } = require("../utils/sentry");

/**
 * Processes a batch of docs: bulk-indexes into OpenSearch, logs results.
 * Item-level failures go to the Dead Letter Queue for later replay.
 *
 * @param {Object[]} documents - Array of { id, fields }
 * @param {number}   rangeIndex - Range index (for DLQ tracking)
 * @returns {{ succeeded: number, failed: number }}
 */
async function processBatch(documents, rangeIndex = -1) {
  let succeeded = 0;
  let failed    = 0;
  const batchLogs  = [];
  const dlqEntries = [];

  try {
    const response = await retry(() => bulkIndex(documents));
    const items    = response.items || [];

    for (let i = 0; i < documents.length; i++) {
      const doc        = documents[i];
      const resultItem = items[i] ? items[i][Object.keys(items[i])[0]] : null;

      if (resultItem && resultItem.error) {
        if (resultItem.status === 429) {
          const err = new Error(`OpenSearch rate-limited (429): ${resultItem.error.reason || 'Quota exceeded'}`);
          err.meta  = { statusCode: 429 };
          throw err; // Let retry.js handle the whole batch
        }
        const errorMsg = resultItem.error.reason || resultItem.error.type || JSON.stringify(resultItem.error);
        batchLogs.push(logItemStatus(doc, 'FAILED', resultItem.error));
        dlqEntries.push({ ucid: doc.id, error: errorMsg, rangeIndex });
        failed++;

        // Report item-level indexing error to Sentry
        const itemErr = new Error(`Document indexing failed: ${errorMsg}`);
        captureException(itemErr, {
          tags: { process: "migrationWorker.js", phase: "item-indexing", rangeIndex, ucid: doc.id },
          extra: { errorDetails: resultItem.error }
        });
      } else {
        batchLogs.push(logItemStatus(doc, 'SUCCESS'));
        succeeded++;
      }
    }
  } catch (error) {
    if (error?.meta?.statusCode === 429) throw error; // propagate to retry.js

    // Whole batch failed — all docs go to DLQ for replay
    mainLogger.error(`Batch processing failed: ${error.message}`);
    captureException(error, {
      tags: { process: "migrationWorker.js", phase: "batch-processing", rangeIndex },
      extra: { docCount: documents.length }
    });
    for (const doc of documents) {
      batchLogs.push(logItemStatus(doc, 'FAILED', error));
      dlqEntries.push({ ucid: doc.id, error: error.message, rangeIndex });
      failed++;
    }
  }

  // ── Write item-level failures to Dead Letter Queue ───────────────────────
  if (dlqEntries.length > 0) {
    dlq.addFailedItems(dlqEntries);
    mainLogger.warn(`DLQ: ${dlqEntries.length} docs queued for replay (range #${rangeIndex}).`);
  }

  // ── Persist logs ─────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "prod" && batchLogs.length > 0) {
    logBuffer.addLogs(batchLogs); // non-blocking
  }
  if (process.env.NODE_ENV !== "prod") {
    checkAndRotateLog('logs/migrated.log');
    checkAndRotateLog('logs/failed.log');
  }

  return { succeeded, failed };
}

function logItemStatus(doc, status, error = null) {
  const isProd    = process.env.NODE_ENV === "prod";
  const logEntry  = { ucid: doc.id, status };

  if (error) {
    logEntry.whyfailed = error.reason || error.message || (typeof error === 'string' ? error : JSON.stringify(error));
    if (!isProd) {
      logEntry.data    = doc.fields;
      logEntry.type    = error.type;
      logEntry.details = error.caused_by ? `Caused by: ${error.caused_by.reason}` : JSON.stringify(error);
    }
  } else if (!isProd) {
    logEntry.data = doc.fields;
  }

  if (!isProd) {
    const logger = status === 'SUCCESS' ? migratedLogger : failedLogger;
    logger[status === 'SUCCESS' ? 'info' : 'error'](logEntry);
  }

  return logEntry;
}

module.exports = processBatch;
