/**
 * Dead Letter Queue — tracks individual documents that failed to index.
 *
 * Failed UCIDs are appended to migration-dlq.ndjson (newline-delimited JSON).
 * Run `node replay-failed.js` to re-fetch and re-index all failed docs.
 *
 * Design:
 *  - Append-only during migration (never blocks the hot path)
 *  - Deduplication happens at replay time
 *  - Each line: { ucid, error, rangeIndex, timestamp }
 */

const fs   = require("fs");
const path = require("path");
const { mainLogger } = require("./logger");

const DLQ_FILE = path.join(__dirname, "../migration-dlq.ndjson");

/**
 * Append one or more failed item records to the DLQ file.
 * @param {{ ucid: string, error: string, rangeIndex: number }[]} items
 */
function addFailedItems(items) {
  if (!items || items.length === 0) return;
  const ts    = new Date().toISOString();
  const lines = items
    .map(item => JSON.stringify({ ucid: item.ucid, error: item.error, rangeIndex: item.rangeIndex ?? -1, timestamp: ts }))
    .join("\n") + "\n";
  try {
    fs.appendFileSync(DLQ_FILE, lines);
  } catch (err) {
    mainLogger.warn(`DLQ write failed: ${err.message}`);
  }
}

/** Returns how many failed entries are in the queue. */
function count() {
  if (!fs.existsSync(DLQ_FILE)) return 0;
  const content = fs.readFileSync(DLQ_FILE, "utf8").trim();
  return content ? content.split("\n").length : 0;
}

/** Loads and deduplicates all DLQ entries (keeps latest per ucid). */
function loadAll() {
  if (!fs.existsSync(DLQ_FILE)) return [];
  const content = fs.readFileSync(DLQ_FILE, "utf8").trim();
  if (!content) return [];

  const byUcid = new Map();
  for (const line of content.split("\n")) {
    try {
      const entry = JSON.parse(line);
      byUcid.set(entry.ucid, entry); // overwrite keeps latest
    } catch (_) { /* skip malformed lines */ }
  }
  return Array.from(byUcid.values());
}

/** Remove entries whose UCIDs were successfully replayed. */
function removeSucceeded(succeededUcids) {
  if (!fs.existsSync(DLQ_FILE) || succeededUcids.length === 0) return;
  const successSet  = new Set(succeededUcids);
  const remaining   = loadAll().filter(e => !successSet.has(e.ucid));
  if (remaining.length === 0) {
    fs.unlinkSync(DLQ_FILE);
  } else {
    const lines = remaining.map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(DLQ_FILE, lines);
  }
}

/** Wipe the DLQ (call after a fully successful replay). */
function clear() {
  if (fs.existsSync(DLQ_FILE)) fs.unlinkSync(DLQ_FILE);
}

module.exports = { addFailedItems, count, loadAll, removeSucceeded, clear };
