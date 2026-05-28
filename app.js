require("dotenv").config();
const { captureException, Sentry, isEnabled } = require("./utils/sentry");
const startMigration = require("./migration/migrationManager");
const { closePool } = require("./services/mySqlService");
const { mainLogger } = require("./utils/logger");

async function run() {
  try {
    mainLogger.info("Migration starting...");
    await startMigration();
    mainLogger.info("Migration finished successfully.");
  } catch (error) {
    mainLogger.error(`Migration failed: ${error.message}`);
    captureException(error, { tags: { process: "app.js" } });
    process.exitCode = 1;
  } finally {
    // Always drain the MySQL connection pool so the process exits cleanly.
    await closePool();
    if (isEnabled) {
      await Sentry.close(2000).catch(() => {});
    }
  }
}

run();
