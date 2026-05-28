const winston = require("winston");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    const msg = typeof message === "object" ? JSON.stringify(message) : message;
    return `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
  })
);

// mainLogger: Handles process-level events, stats, and major errors.
// Output: logs/migration.log AND Console (optimized for shell redirection)
const mainLogger = winston.createLogger({
  format: logFormat,
  transports: [
    new winston.transports.File({ filename: "logs/migration.log" }),
    new winston.transports.Console(),
  ],
});

// migratedLogger: Audit trail of every UCID successfully indexed.
// Output: logs/migrated.log (JSON/Text per line)
const migratedLogger = winston.createLogger({
  format: logFormat,
  transports: [
    new winston.transports.File({ filename: "logs/migrated.log" }),
  ],
});

// failedLogger: Detailed audit of skipped or failed individual documents.
// Output: logs/failed.log
const failedLogger = winston.createLogger({
  format: logFormat,
  transports: [
    new winston.transports.File({ filename: "logs/failed.log" }),
  ],
});

/**
 * Checks if a log file exceeds 10MB and rotates it by zipping.
 * The zip filename is named based on the first and last UCID in the log.
 */
function checkAndRotateLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (stats.size < maxSize) return;

    mainLogger.info(`Rotating log file: ${logPath} (Size: ${(stats.size / (1024 * 1024)).toFixed(2)}MB)`);

    // Get first and last UCID using shell commands for efficiency on large files
    const firstLine = execSync(`head -n 1 "${logPath}"`).toString();
    const lastLine = execSync(`tail -n 1 "${logPath}"`).toString();

    const ucidRegex = /"ucid":"([^"]+)"/;
    const firstMatch = firstLine.match(ucidRegex);
    const lastMatch = lastLine.match(ucidRegex);

    const startUcid = firstMatch ? firstMatch[1].replace(/[*]/g, '') : 'start';
    const endUcid = lastMatch ? lastMatch[1].replace(/[*]/g, '') : 'end';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipName = `${startUcid}_to_${endUcid}_${timestamp}.zip`;
    const zipPath = path.join(path.dirname(logPath), zipName);

    // Zip the file
    mainLogger.info(`Creating zip: ${zipPath}`);
    execSync(`zip -j "${zipPath}" "${logPath}"`);

    // Truncate the original log file
    fs.writeFileSync(logPath, '');
    mainLogger.info(`Successfully rotated and zipped log to ${zipName}`);
  } catch (error) {
    mainLogger.error(`Error during log rotation for ${logPath}: ${error.message}`);
  }
}

module.exports = {
  mainLogger,
  migratedLogger,
  failedLogger,
  checkAndRotateLog
};
