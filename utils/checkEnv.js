require("dotenv").config();

// ─── Variables required for the migration source (AWS RDS) ─────────────────
const REQUIRED_SOURCE_VARS = [
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
];

// ─── Variables required for the local log DB ────────────────────────────────
//     If NODE_ENV=prod the log pool is always initialised; all four must exist.
const REQUIRED_LOG_VARS = [
  "MYSQL_LOG_HOST",
  "MYSQL_LOG_PORT",
  "MYSQL_LOG_USER",
  "MYSQL_LOG_PASSWORD",
  "MYSQL_LOG_DATABASE",
];

// ─── Variables required for OpenSearch ──────────────────────────────────────
const REQUIRED_OS_VARS = [
  "OPENSEARCH_ENDPOINT",
  "OPENSEARCH_USERNAME",
  "OPENSEARCH_PASSWORD",
  "OPENSEARCH_INDEX",
];

// ─── Run-time tuning (optional — defaults exist in code but warn if absent) ──
const TUNING_VARS = [
  "BATCH_SIZE",
  "PARALLEL_WORKERS",
  "OPENSEARCH_BULK_MB",
  "MAX_RETRIES",
  "SLEEP_ON_429_MS",
  "LOG_BATCH_SIZE",
  "NODE_ENV",
];

// ─── Dead / legacy vars — warn if still present ─────────────────────────────
const DEAD_VARS = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDSEARCH_ENDPOINT",
];

function checkEnv() {
  console.log("🔍 Checking environment variables...");
  const missing = [];

  const isProd = process.env.NODE_ENV === "prod";

  // Always required
  for (const key of [...REQUIRED_SOURCE_VARS, ...REQUIRED_OS_VARS]) {
    if (!process.env[key]) missing.push(key);
  }

  // Log DB required in prod (migration_logs written to local Docker MySQL)
  if (isProd) {
    for (const key of REQUIRED_LOG_VARS) {
      if (!process.env[key]) missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error("❌ ERROR: Missing required environment variables in .env:");
    missing.forEach(m => console.error(`   - ${m}`));
    console.error("\n Please check your .env file and ensure all required variables are set.");
    process.exit(1);
  }

  // Warn about missing tuning vars (non-fatal)
  const missingTuning = TUNING_VARS.filter(k => !process.env[k]);
  if (missingTuning.length > 0) {
    console.warn("⚠️  Tuning variables using code defaults (consider setting in .env):");
    missingTuning.forEach(k => console.warn(`   - ${k}`));
  }

  // Warn about dead / unused credentials still present
  const deadPresent = DEAD_VARS.filter(k => process.env[k]);
  if (deadPresent.length > 0) {
    console.warn("⚠️  Unused/legacy variables found in .env (safe to remove):");
    deadPresent.forEach(k => console.warn(`   - ${k}`));
  }

  console.log(`✅ All required environment variables are present (NODE_ENV=${process.env.NODE_ENV}).`);
}

checkEnv();
