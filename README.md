# MySQL → OpenSearch Migration Tool

A robust Node.js tool to migrate matter documents from a MySQL database to AWS OpenSearch. Designed specifically for massive, multi-million record databases, the tool features high-concurrency read-ahead prefetching, memory-safe streaming, dynamic bulk payload size capping, background execution daemon management, and resilient fail-fast / retry logic.

---

## Prerequisites

| Requirement | Version | Description |
|-------------|---------|-------------|
| Node.js | v20+ | Recommended (supports memory expansion flags) |
| npm | v9+ | Package manager |
| MySQL | v8+ | Source Database (requires SELECT permissions) |
| OpenSearch | v2+ | Target Index (requires Document Bulk privileges) |

---

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your connections and tuning details. The recommended production defaults are pre-configured:

```env
# OpenSearch Destination (AWS or Local)
OPENSEARCH_ENDPOINT=https://your-domain.es.amazonaws.com
OPENSEARCH_USERNAME=admin
OPENSEARCH_PASSWORD=admin
OPENSEARCH_INDEX=patent-matters

# MySQL Source
MYSQL_HOST=your-rds-host.rds.amazonaws.com
MYSQL_PORT=3306
MYSQL_USER=your_username
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=matters_db

# MySQL Destination for Logs (local Docker)
MYSQL_LOG_HOST=127.0.0.1
MYSQL_LOG_PORT=3306
MYSQL_LOG_USER=root
MYSQL_LOG_PASSWORD=mysql
MYSQL_LOG_DATABASE=matters_db

# Performance & Tuning (Optimal Production Configuration)
BATCH_SIZE=1000
PARALLEL_WORKERS=4
OPENSEARCH_BULK_MB=10
MAX_RETRIES=5
SLEEP_ON_429_MS=10000
NODE_ENV=prod
```

### 2. Run the Migration

The helper script handles dependency installation, configurations validation, and background process management.

**Linux / macOS:**
```bash
bash setup_and_run.sh
```

**Windows:**
```batch
setup_and_run.bat
```

The script will automatically:
1. Verify **Node.js** and **npm** are installed on the system.
2. Install dependencies (`npm install`) automatically if `node_modules` is missing.
3. Validate that all required environment variables are set.
4. Launch the process in the **background** (on Linux/Mac) with a 4GB heap allocation (`--max-old-space-size=4096`) to prevent memory constraints.

---

## Script Commands (Linux/macOS)

| Command | Description |
|---------|-------------|
| `bash setup_and_run.sh` | Install dependencies, validate env, and start migration in background |
| `bash setup_and_run.sh --status` | Check if background migration daemon is running |
| `bash setup_and_run.sh --logs` | Tail the background stdout/stderr execution log (`logs/migration_run.log`) |
| `bash setup_and_run.sh --stop` | Stop the background migration daemon gracefully |

---

## Resuming Progress & Clearing State

The migration tool utilizes a cursor-based approach using pre-computed boundaries. Progress is saved after every batch to `migration-progress.json`.

* **To Resume**: Simply run `bash setup_and_run.sh`. The tool reads `migration-progress.json` and skips already completed batch index ranges.
* **To Start Fresh**: Delete the progress tracking file:
  ```bash
  rm -f migration-progress.json logs/migration_run.log
  ```

---

## Performance Optimizations (Under the Hood)

### 1. Memory-Safe Startup (Cursor Range Streaming)
Instead of buffering all database keys in Node.js RAM to divide range boundaries (which causes V8 heap allocation crashes for databases with millions of rows), the tool uses a **MySQL cursor stream**. It streams keys chunk-by-chunk and only saves boundary indices to memory, keeping startup memory usage under 2MB.

### 2. Dynamic Payload Size Capping (`OPENSEARCH_BULK_MB`)
AWS OpenSearch limits incoming HTTP request bodies (usually to 10MB or 100MB depending on instance settings). If a bulk payload is too large, the load balancer abruptly disconnects (`EPIPE` Broken Pipe) or OpenSearch throws an HTTP 413 error. 
Our tool estimates the byte size of each bulk payload prior to transmission. If it exceeds `OPENSEARCH_BULK_MB`, it is safely sliced into smaller sub-bulks and sent sequentially.

### 3. Fail-Fast for Size Limits
Client-side errors such as HTTP `413 Request Entity Too Large` cannot be fixed by retrying. The retry manager automatically treats `413` as a fatal code and halts immediately to save resources instead of burning through retry attempts.

### 4. Database Collation Optimization
The connection pool charset is configured matching the database column collation (`charset: 'utf8'`). This prevents MySQL from bypassing indices to perform character conversions, converting key query times from minutes to milliseconds.
