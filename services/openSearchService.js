const { Client } = require("@opensearch-project/opensearch");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { mainLogger } = require("../utils/logger");

// ─── CLIENT SETUP ────────────────────────────────────────────────────────────



const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // handles both self-signed certs and AWS OpenSearch
  family: 4,
});

const client = new Client({
  node: process.env.OPENSEARCH_ENDPOINT,
  auth: {
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
  },
  ssl: { rejectUnauthorized: false },
  agent: () => httpsAgent,
  maxRetries: 0,          // Disable SDK retries; our retry.js handles this
  requestTimeout: 120000, // 2-minute timeout per request
});

// ─── PAYLOAD SIZE CAP ────────────────────────────────────────────────────────

// Maximum bulk payload in bytes before we split into sub-bulks.
// Default: 5MB. Adjust via OPENSEARCH_BULK_MB env var.
const MAX_BULK_BYTES = (parseFloat(process.env.OPENSEARCH_BULK_MB) || 5) * 1024 * 1024;

/**
 * Estimates the byte size of a bulk body array (pairs of action + doc).
 * Uses a fast approximation via JSON.stringify length (1 char ≈ 1 byte for ASCII).
 */
function estimatePayloadSize(bodyPairs) {
  let size = 0;
  for (const item of bodyPairs) {
    size += JSON.stringify(item).length + 1; // +1 for newline
  }
  return size;
}

/**
 * Splits a flat bulk body array into sub-arrays each under MAX_BULK_BYTES.
 * Each element of the returned array is a valid body array (pairs of action+doc).
 */
function splitBulkBody(body) {
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (let i = 0; i < body.length; i += 2) {
    const action = body[i];
    const doc = body[i + 1];
    const pairSize = JSON.stringify(action).length + JSON.stringify(doc).length + 2;

    if (currentChunk.length > 0 && currentSize + pairSize > MAX_BULK_BYTES) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(action, doc);
    currentSize += pairSize;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ─── INDEX INITIALIZATION ─────────────────────────────────────────────────────

async function initializeIndex() {
  const indexName = process.env.OPENSEARCH_INDEX || "matters";

  try {
    const existsResponse = await client.indices.exists({ index: indexName });
    // SDK v3 returns response directly; SDK v2 wraps in .body
    const exists = existsResponse.body !== undefined
      ? existsResponse.body
      : existsResponse;

    if (exists) {
      mainLogger.info(`Index "${indexName}" already exists, skipping creation.`);
      return;
    }

    const mappingPath = path.join(__dirname, "../config/opensearch_mapping.json");
    const mappingConfig = JSON.parse(fs.readFileSync(mappingPath, "utf8"));

    await client.indices.create({
      index: indexName,
      body: mappingConfig,
    });

    mainLogger.info(`Index "${indexName}" created with mapping from opensearch_mapping.json.`);
  } catch (error) {
    // Two parallel runs can both see the index as missing and both try to create it.
    // Treat resource_already_exists_exception as a non-fatal race condition.
    const errType = error?.meta?.body?.error?.type;
    if (errType === "resource_already_exists_exception") {
      mainLogger.warn(`Index "${indexName}" already exists (concurrent creation race). Continuing.`);
      return;
    }
    mainLogger.error(`Error initializing index "${indexName}": ${error.message}`);
    throw error;
  }
}

/**
 * Executes a bulk index request and wraps any low-level/HTTP errors in a descriptive message.
 */
async function executeBulkWithFriendlyErrors(body) {
  try {
    const raw = await client.bulk({ body });
    return raw.body !== undefined ? raw.body : raw;
  } catch (error) {
    // 1. Handle SDK ResponseErrors (HTTP non-2xx status codes)
    if (error.name === "ResponseError") {
      const statusCode = error.meta?.statusCode;
      const errorType = error.meta?.body?.error?.type || "unknown_reason";
      const errorReason = error.meta?.body?.error?.reason || error.message;

      let friendlyMsg = `[OpenSearch HTTP ${statusCode}] `;
      if (statusCode === 413) {
        friendlyMsg += `Request Entity Too Large (AWS Hard Limit Exceeded). Raw payload size exceeds the maximum allowed HTTP request size.`;
      } else if (statusCode === 401 || statusCode === 403) {
        friendlyMsg += `Unauthorized / Forbidden access. Please check your credentials.`;
      } else if (statusCode === 504 || statusCode === 502) {
        friendlyMsg += `Gateway Timeout / Bad Gateway. The server took too long to process the request.`;
      } else {
        friendlyMsg += `Error Type: ${errorType} | Reason: ${errorReason}`;
      }

      const newErr = new Error(friendlyMsg);
      newErr.name = "OpenSearchLimitError";
      newErr.statusCode = statusCode;
      newErr.originalError = error;
      throw newErr;
    }

    // 2. Handle Network connection errors (EPIPE, ECONNRESET, etc.)
    if (error.code) {
      let friendlyMsg = `[OpenSearch Network Error] Connection failed (${error.code}). `;
      if (error.code === "EPIPE") {
        friendlyMsg += `Broken pipe. The AWS OpenSearch server abruptly closed the connection. This typically happens when sending a payload that exceeds the AWS hard size limit (usually 10MB or 100MB).`;
      } else if (error.code === "ECONNRESET") {
        friendlyMsg += `Connection reset by peer. The network connection was forcefully terminated by the server.`;
      } else if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") {
        friendlyMsg += `Socket timed out. The request did not receive a response in time.`;
      } else {
        friendlyMsg += `Error message: ${error.message}`;
      }

      const newErr = new Error(friendlyMsg);
      newErr.name = "OpenSearchNetworkError";
      newErr.code = error.code;
      newErr.originalError = error;
      throw newErr;
    }

    // 3. Catch-all
    throw error;
  }
}

// ─── BULK INDEXING ───────────────────────────────────────────────────────────

/**
 * Bulk-indexes a batch of documents into OpenSearch.
 *
 * Automatically splits the payload into sub-bulks if it exceeds MAX_BULK_BYTES
 * to prevent 413 errors or silent timeouts on large document batches.
 *
 * Returns a combined response object with a merged items[] array so that
 * migrationWorker.js sees no difference in the response shape.
 *
 * @param {Object[]} documents - Array of { id, fields }
 * @returns {{ errors: boolean, items: Object[] }}
 */
async function bulkIndex(documents) {
  if (documents.length === 0) return { errors: false, items: [] };

  const indexName = process.env.OPENSEARCH_INDEX || "matters";

  // Build the full flat body array
  const fullBody = [];
  for (const doc of documents) {
    fullBody.push({ index: { _index: indexName, _id: doc.id } });
    fullBody.push(doc.fields || {});
  }

  // Estimate total size; if under limit, send in one shot
  const estimatedSize = estimatePayloadSize(fullBody);
  if (estimatedSize <= MAX_BULK_BYTES) {
    const result = await executeBulkWithFriendlyErrors(fullBody);
    return result;
  }

  // Payload too large — split and send as sequential sub-bulks, then merge
  const chunks = splitBulkBody(fullBody);
  mainLogger.warn(
    `Bulk payload ~${(estimatedSize / 1024 / 1024).toFixed(1)}MB exceeds ${process.env.OPENSEARCH_BULK_MB || 5}MB cap. ` +
    `Splitting into ${chunks.length} sub-bulks.`
  );

  let hasErrors = false;
  const allItems = [];

  for (const chunk of chunks) {
    const result = await executeBulkWithFriendlyErrors(chunk);
    if (result.errors) hasErrors = true;
    allItems.push(...(result.items || []));
  }

  return { errors: hasErrors, items: allItems };
}

module.exports = {
  bulkIndex,
  initializeIndex,
};
