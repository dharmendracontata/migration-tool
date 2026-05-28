const { mainLogger } = require("./logger");
const { captureMessage } = require("./sentry");

// These HTTP status codes indicate a client-side / permanent error that
// retrying won't fix.  Fail fast instead of burning all retries.
const FATAL_STATUS_CODES = [400, 403, 404, 413];

async function retry(fn, retries = parseInt(process.env.MAX_RETRIES) || 3, delay = 1000) {
  try {
    return await fn();
  } catch (err) {
    const statusCode = err.statusCode || err?.meta?.statusCode;

    // Don't retry permanent/client errors
    if (FATAL_STATUS_CODES.includes(statusCode)) {
      mainLogger.error(`Non-retriable error (HTTP ${statusCode}): ${err.message}`);
      throw err;
    }

    if (retries <= 0) {
      throw err;
    }

    // Honour the SLEEP_ON_429_MS env var or Retry-After header for 429 Too Many Requests
    let waitMs = delay;
    if (statusCode === 429) {
      const envSleep = parseInt(process.env.SLEEP_ON_429_MS);
      const retryAfter = err?.meta?.headers?.["retry-after"];
      let msg = '';
      
      if (!isNaN(envSleep)) {
        waitMs = envSleep;
        msg = `Rate-limited by OpenSearch. Sleeping for ${waitMs}ms (from SLEEP_ON_429_MS).`;
      } else if (retryAfter) {
        waitMs = parseInt(retryAfter) * 1000;
        msg = `Rate-limited by OpenSearch. Waiting ${waitMs}ms (Retry-After header).`;
      } else {
        msg = `Rate-limited by OpenSearch. Waiting ${waitMs}ms before retry.`;
      }
      mainLogger.warn(msg);
      captureMessage(msg, "warning", { tags: { source: "retry.js", reason: "rate-limit" } });
    } else {
      const msg = `Retrying operation (${retries} retries left)... Error: ${err.message}`;
      mainLogger.warn(msg);
      captureMessage(msg, "warning", { tags: { source: "retry.js", reason: "error" } });
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    return retry(fn, retries - 1, delay * 2); // Exponential back-off
  }
}

module.exports = retry;
