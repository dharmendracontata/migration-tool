@echo off
SETLOCAL EnableDelayedExpansion

:: Cloud Search to OpenSearch Migration Tool - Setup & Run Script (Windows)
:: -------------------------------------------------------------------------

echo Starting Migration Tool Setup...

:: Load .env if it exists
if exist .env (
    echo Loading environment variables from .env...
    for /f "tokens=*" %%i in ('type .env ^| findstr /v "^#"') do (
        set %%i
    )
)

:: Set default fallbacks if missing
if "!MYSQL_HOST!"=="" set MYSQL_HOST=127.0.0.1
if "!MYSQL_PORT!"=="" set MYSQL_PORT=3306
if "!MYSQL_USER!"=="" set MYSQL_USER=root
if "!MYSQL_PASSWORD!"=="" set MYSQL_PASSWORD=mysql
if "!MYSQL_DATABASE!"=="" set MYSQL_DATABASE=matters_db

if "!OPENSEARCH_ENDPOINT!"=="" set OPENSEARCH_ENDPOINT=https://localhost:9200
if "!OPENSEARCH_USERNAME!"=="" set OPENSEARCH_USERNAME=admin
if "!OPENSEARCH_PASSWORD!"=="" set OPENSEARCH_PASSWORD=admin
if "!OPENSEARCH_INDEX!"=="" set OPENSEARCH_INDEX=patent-matters

if "!BATCH_SIZE!"=="" set BATCH_SIZE=100
if "!PARALLEL_WORKERS!"=="" set PARALLEL_WORKERS=5
if "!MAX_RETRIES!"=="" set MAX_RETRIES=3
if "!SLEEP_ON_429_MS!"=="" set SLEEP_ON_429_MS=5000
if "!NODE_ENV!"=="" set NODE_ENV=dev

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ ERROR: Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/ (v20+ recommended).
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo ✔ Found Node.js version: %NODE_VERSION%

:: Check npm
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ ERROR: npm is not installed.
    echo Please install npm (usually comes with Node.js).
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('npm -v') do set NPM_VERSION=%%v
echo ✔ Found npm version: %NPM_VERSION%

:: Install npm dependencies
if not exist node_modules (
    echo 📦 Installing dependencies...
    call npm install --silent
    if %errorlevel% neq 0 (
        echo ❌ ERROR: npm install failed.
        pause
        exit /b 1
    )
    echo ✔ Dependencies installed.
) else (
    echo ✔ Dependencies already installed.
)

:: Run environment variable check
echo ⚙️  Validating environment configuration...
node utils\checkEnv.js
if %errorlevel% neq 0 (
    pause
    exit /b 1
)

if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

:: Run the migration
echo Starting migration...
node app.js

if %errorlevel% neq 0 (
    echo Migration process ended with errors.
    pause
)

ENDLOCAL
