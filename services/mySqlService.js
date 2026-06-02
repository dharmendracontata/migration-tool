const mysql = require('mysql2/promise');
const { mapSqlRowToOpenSearch } = require('../utils/sqlToOsMapping');
const { mainLogger } = require('../utils/logger');

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const SELECTED_COLUMNS = [
  'pm.matter_ucid', 'pm.title', 'pm.title_lang', 'pm.title_en', 'pm.application_country',
  'pm.serial_number', 'pm.matter_type', 'pm.matter_status', 'pm.filing_type',
  'pm.filing_date', 'pm.parent_filing_date', 'pm.pct_filing_date', 'pm.national_entry_date',
  'pm.grant_publication_date', 'pm.application_publication_date', 'pm.priority_date',
  'pm.claims_count', 'pm.independent_claims_count', 'pm.all_claims_xml', 'pm.abstract',
  'pm.abstract_lang', 'pm.abstract_en', 'pm.entity_size', 'pm.patent_ucid',
  'pm.application_publication_ucid', 'pm.local_registration_number', 'pm.parent_matter_ucid',
  'pm.description', 'pm.grant_date', 'pm.pendency_days', 'pm.modified_on',
  'pm.family_id',
  'cpm.allowance_date', 'cpm.complete_specification_date', 'cpm.request_examination_date'
].join(', ');

const PARALLEL_WORKERS = parseInt(process.env.PARALLEL_WORKERS) || 5;

// ─── CONNECTION POOLS ────────────────────────────────────────────────────────

let sourcePool;  // Staging RDS — reads only
let logPool;     // MySQL Log DB — migration_prod_logs writes only

function getPool() {
  if (!sourcePool) {
    sourcePool = mysql.createPool({
      host:               process.env.MYSQL_HOST     || '127.0.0.1',
      port:               parseInt(process.env.MYSQL_PORT) || 3306,
      user:               process.env.MYSQL_USER     || 'root',
      password:           process.env.MYSQL_PASSWORD || 'root',
      database:           process.env.MYSQL_DATABASE || 'matters_db',
      charset:            'utf8',
      waitForConnections: true,
      // Each range fetch fires 7 parallel sub-queries; size pool accordingly.
      connectionLimit:    Math.max(30, PARALLEL_WORKERS * 8),
      queueLimit:         500,
      maxIdle:            Math.max(10, PARALLEL_WORKERS * 2),
      idleTimeout:        60000,
      connectTimeout:     15000,
    });
    mainLogger.info(`MySQL source pool created → ${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT || 3306}`);
  }
  return sourcePool;
}

function getLogPool() {
  if (!logPool) {
    const logHost = process.env.MYSQL_LOG_HOST;

    // Hard-fail if log DB is not configured — we must NOT fall back to the
    // Hard-fail if log DB is not configured — we must NOT fall back to the
    // read-only source RDS or silently lose migration_prod_logs.
    if (!logHost) {
      throw new Error(
        'MYSQL_LOG_HOST is not set. ' +
        'Set MYSQL_LOG_* variables in .env to point at your MySQL Log DB ' +
        'where migration_prod_logs should be written. ' +
        'Do NOT reuse the source RDS credentials here.'
      );
    }

    logPool = mysql.createPool({
      host:               logHost,
      port:               parseInt(process.env.MYSQL_LOG_PORT) || 3306,
      user:               process.env.MYSQL_LOG_USER     || 'root',
      password:           process.env.MYSQL_LOG_PASSWORD || 'mysql',
      database:           process.env.MYSQL_LOG_DATABASE || 'matters_db',
      waitForConnections: true,
      connectionLimit:    10,
      queueLimit:         100,
      idleTimeout:        60000,
      connectTimeout:     15000,
    });
    mainLogger.info(`MySQL log pool → ${logHost}:${process.env.MYSQL_LOG_PORT || 3306}`);
  }
  return logPool;
}

async function closePool() {
  const closers = [];
  if (sourcePool) closers.push(sourcePool.end().catch(e => mainLogger.warn(e.message)).finally(() => { sourcePool = null; }));
  if (logPool)    closers.push(logPool.end().catch(e => mainLogger.warn(e.message)).finally(() => { logPool = null; }));
  await Promise.all(closers);
  mainLogger.info('MySQL pools closed.');
}

// ─── CHILD DATA FETCHERS (shared by fetchRange + fetchByUcids) ───────────────

async function fetchParties(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT l.matter_ucid, p.party_type, p.party_std_name, p.party_country, p.party_address
     FROM public_matter_party_link l
     JOIN matter_party p ON l.matter_party_id = p.matter_party_id
     WHERE l.matter_ucid IN (?) ORDER BY l.matter_ucid, l.sequence`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchDocuments(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT m.application_reference_ucid as matter_ucid, m.publication_ucid, c.document_type
     FROM ifi_publication_application_map m
     LEFT JOIN country_kind_code_description c ON
       c.country_code = SUBSTRING_INDEX(m.publication_ucid, '-', 1) AND
       c.kind_code = SUBSTRING_INDEX(m.publication_ucid, '-', -1)
     WHERE m.application_reference_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchCitations(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT cited_by_matter_ucid as matter_ucid, cited_publication_ucid, source_name
     FROM public_matter_citation_link WHERE cited_by_matter_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchPriorityClaims(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT claimed_by_matter_ucid as matter_ucid, claimed_matter_ucid, claimed_matter_filing_date
     FROM public_matter_priority_claim_link WHERE claimed_by_matter_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchClassifications(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT matter_ucid, classification_code_type, classification_code
     FROM public_matter_classification WHERE matter_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchEpCountries(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT matter_ucid, designated_country, status, status_type,
            status_date, fee_payment_date, designated_country_matter_ucid
     FROM public_matter_ep_designated_country WHERE matter_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}
async function fetchLegalStatusEvents(matterUcids) {
  if (!matterUcids.length) return {};
  const [rows] = await getPool().query(
    `SELECT matter_ucid, code, country, date_of_public_notification
     FROM public_matter_legal_status_event WHERE matter_ucid IN (?)`, [matterUcids]);
  return groupByUcid(rows);
}

function groupByUcid(rows) {
  const map = {};
  for (const row of rows) {
    if (!map[row.matter_ucid]) map[row.matter_ucid] = [];
    map[row.matter_ucid].push(row);
  }
  return map;
}

async function fetchFamilyMembers(familyIds) {
  const filtered = familyIds.filter(Boolean);
  if (!filtered.length) return {};
  const [rows] = await getPool().query(
    'SELECT matter_ucid, family_id FROM public_matter WHERE family_id IN (?)',
    [filtered]
  );
  const map = {};
  for (const row of rows) {
    if (!map[row.family_id]) map[row.family_id] = [];
    map[row.family_id].push(row.matter_ucid);
  }
  return map;
}

async function fetchForwardCitationsCounts(patentUcids) {
  const filtered = patentUcids.filter(Boolean);
  if (!filtered.length) return {};
  const [rows] = await getPool().query(
    `SELECT cited_publication_ucid,
            COUNT(DISTINCT cited_by_matter_ucid) AS count,
            COUNT(DISTINCT CASE WHEN source_name = 'EXA' THEN cited_by_matter_ucid END) AS count_exa
     FROM public_matter_citation_link
     WHERE cited_publication_ucid IN (?)
     GROUP BY cited_publication_ucid`,
    [filtered]
  );
  const map = {};
  for (const row of rows) {
    map[row.cited_publication_ucid] = {
      count: row.count,
      countExa: row.count_exa
    };
  }
  return map;
}

/**
 * Shared hydration: joins child data onto matter rows and maps to OpenSearch docs.
 */
async function hydrateMatterRows(rows) {
  if (!rows.length) return [];
  const matterUcids    = rows.map(r => r.matter_ucid);
  const patentUcids    = [...new Set(rows.map(r => r.patent_ucid).filter(Boolean))];
  const familyIds      = [...new Set(rows.map(r => r.family_id).filter(Boolean))];

  const [parties, docs, citations, priorities, classifications, epCountries, legalEvents, familyMembersMap, forwardCitationsMap] = await Promise.all([
    fetchParties(matterUcids),
    fetchDocuments(matterUcids),
    fetchCitations(matterUcids),
    fetchPriorityClaims(matterUcids),
    fetchClassifications(matterUcids),
    fetchEpCountries(matterUcids),
    fetchLegalStatusEvents(matterUcids),
    familyIds.length ? fetchFamilyMembers(familyIds) : Promise.resolve({}),
    patentUcids.length ? fetchForwardCitationsCounts(patentUcids) : Promise.resolve({})
  ]);

  return rows.map(row => {
    const familyList = (familyMembersMap[row.family_id] || []).filter(u => u !== row.matter_ucid);
    const forwardCitationInfo = forwardCitationsMap[row.patent_ucid] || { count: 0, countExa: 0 };
    return {
      id:     row.matter_ucid,
      fields: mapSqlRowToOpenSearch({
        ...row,
        _parties:           parties[row.matter_ucid]         || [],
        _documents:         docs[row.matter_ucid]            || [],
        _citations:         citations[row.matter_ucid]       || [],
        _priorities:        priorities[row.matter_ucid]      || [],
        _classifications:   classifications[row.matter_ucid] || [],
        _familyMatters:     familyList,
        _epCountries:       epCountries[row.matter_ucid]     || [],
        _legalStatusEvents: legalEvents[row.matter_ucid]     || [],
        _forwardCitationInfo: forwardCitationInfo
      }),
    };
  });
}

// ─── RANGE PRE-COMPUTATION ───────────────────────────────────────────────────

/**
 * Streams matter_ucid to build range boundary objects incrementally.
 *
 * Supports resuming from a previous crash:
 *   - resumeFromUcid: skip rows already processed (WHERE matter_ucid > ?)
 *   - startIndex:     offset range indices so they don't clash with cached ones
 *
 * Calls onRangesReady(newRanges, isLast) every saveInterval completed ranges
 * (and once more with the final tail batch when the stream ends).  The caller
 * can use this to persist ranges and dispatch migration workers immediately —
 * without waiting for all 333 M rows to be scanned first.
 *
 * @param {number} batchSize
 * @param {object} opts
 * @param {string|null}   opts.resumeFromUcid  - Resume stream after this UCID
 * @param {number}        opts.startIndex       - Index offset for new ranges
 * @param {number}        opts.saveInterval     - Flush every N ranges (default 200)
 * @param {Function|null} opts.onRangesReady   - Callback(newRanges, isLast)
 * @returns {Promise<Array>} All newly computed ranges
 */
async function computeCursorRanges(batchSize, {
  resumeFromUcid = null,
  startIndex     = 0,
  saveInterval   = 200,
  onRangesReady  = null,
} = {}) {
  const resumeMsg = resumeFromUcid
    ? `Resuming stream after UCID: ${resumeFromUcid} (index offset: ${startIndex})`
    : 'Fresh stream from the beginning';
  mainLogger.info(`Computing range boundaries via MySQL stream — ${resumeMsg}`);

  const pool = getPool();
  const conn = await pool.getConnection();

  return new Promise((resolve, reject) => {
    const allNewRanges   = [];   // every range computed in this call
    let   pendingBatch   = [];   // buffer flushed every saveInterval ranges
    let   currentFromUcid = resumeFromUcid || 'initial';
    let   count           = 0;
    let   totalCount      = 0;
    let   lastSeenUcid    = null;

    const limitVal    = process.env.MIGRATION_LIMIT ? parseInt(process.env.MIGRATION_LIMIT) : 0;
    const limitClause = limitVal > 0 ? ` LIMIT ${limitVal}` : '';

    // Build the WHERE clause for resume support
    const escapedResume = resumeFromUcid
      ? conn.connection.escape(resumeFromUcid)
      : null;
    const whereClause = escapedResume ? ` WHERE matter_ucid > ${escapedResume}` : '';

    const stream = conn.connection
      .query(`SELECT matter_ucid FROM public_matter${whereClause} ORDER BY matter_ucid ASC${limitClause}`)
      .stream();

    stream.on('data', (row) => {
      totalCount++;
      count++;
      lastSeenUcid = row.matter_ucid;

      if (count === batchSize) {
        const newRange = {
          index:    startIndex + allNewRanges.length,
          fromUcid: currentFromUcid,
          toUcid:   row.matter_ucid,
          count:    batchSize,
        };
        allNewRanges.push(newRange);
        pendingBatch.push(newRange);
        currentFromUcid = row.matter_ucid;
        count = 0;

        // Flush buffer to caller every saveInterval ranges
        if (onRangesReady && pendingBatch.length >= saveInterval) {
          onRangesReady(pendingBatch.splice(0), false);
        }
      }

      if (totalCount % 100000 === 0) {
        mainLogger.info(
          `Streamed ${totalCount.toLocaleString()} UCIDs... ` +
          `(new ranges: ${allNewRanges.length}, total: ${startIndex + allNewRanges.length})`
        );
      }
    });

    stream.on('end', () => {
      // Handle any tail records that didn't fill a full batch
      if (count > 0 && lastSeenUcid) {
        const tailRange = {
          index:    startIndex + allNewRanges.length,
          fromUcid: currentFromUcid,
          toUcid:   lastSeenUcid,
          count,
        };
        allNewRanges.push(tailRange);
        pendingBatch.push(tailRange);
      }

      // Final flush (isLast = true)
      if (onRangesReady && pendingBatch.length > 0) {
        onRangesReady(pendingBatch.splice(0), true);
      } else if (onRangesReady) {
        // Stream ended with an empty tail — still signal completion
        onRangesReady([], true);
      }

      mainLogger.info(`Total UCIDs scanned this run : ${totalCount.toLocaleString()}`);
      mainLogger.info(
        `New ranges computed : ${allNewRanges.length} ` +
        `(total incl. prior runs: ${startIndex + allNewRanges.length})`
      );
      conn.release();
      resolve(allNewRanges);
    });

    stream.on('error', (err) => {
      mainLogger.error(`Stream error while computing ranges: ${err.message}`);
      conn.release();
      reject(err);
    });
  });
}

// ─── RANGE FETCHER ────────────────────────────────────────────────────────────

/**
 * Fetches matter rows within a pre-computed range (fromUcid, toUcid].
 * Uses bounded WHERE clause so ranges never overlap regardless of parallel execution.
 *
 * @param {string} fromUcid - Lower bound (exclusive), or 'initial'
 * @param {string} toUcid   - Upper bound (inclusive)
 */
async function fetchRange(fromUcid, toUcid) {
  const pool      = getPool();
  const isInitial = fromUcid === 'initial';

  let query, params;
  if (isInitial) {
    query  = `SELECT ${SELECTED_COLUMNS} FROM public_matter pm
              LEFT JOIN client_private_matter cpm ON pm.matter_ucid = cpm.matter_ucid
              WHERE pm.matter_ucid <= ? ORDER BY pm.matter_ucid ASC`;
    params = [toUcid];
  } else {
    query  = `SELECT ${SELECTED_COLUMNS} FROM public_matter pm
              LEFT JOIN client_private_matter cpm ON pm.matter_ucid = cpm.matter_ucid
              WHERE pm.matter_ucid > ? AND pm.matter_ucid <= ?
              ORDER BY pm.matter_ucid ASC`;
    params = [fromUcid, toUcid];
  }

  const [rows] = await pool.query(query, params);
  return hydrateMatterRows(rows);
}

// ─── DLQ REPLAY FETCHER ───────────────────────────────────────────────────────

/**
 * Fetch and hydrate specific matter UCIDs for DLQ replay.
 * @param {string[]} ucids
 */
async function fetchByUcids(ucids) {
  if (!ucids.length) return [];
  const [rows] = await getPool().query(
    `SELECT ${SELECTED_COLUMNS} FROM public_matter pm
     LEFT JOIN client_private_matter cpm ON pm.matter_ucid = cpm.matter_ucid
     WHERE pm.matter_ucid IN (?) ORDER BY pm.matter_ucid ASC`,
    [ucids]
  );
  return hydrateMatterRows(rows);
}

// ─── LEGACY BATCH FETCH (used by benchmark.js) ────────────────────────────────

async function fetchBatch(cursor) {
  const batchSize = parseInt(process.env.BATCH_SIZE) || 100;
  const isInitial = cursor === 'initial';
  const pool      = getPool();
  const query     = isInitial
    ? `SELECT ${SELECTED_COLUMNS} FROM public_matter pm LEFT JOIN client_private_matter cpm ON pm.matter_ucid = cpm.matter_ucid ORDER BY pm.matter_ucid ASC LIMIT ?`
    : `SELECT ${SELECTED_COLUMNS} FROM public_matter pm LEFT JOIN client_private_matter cpm ON pm.matter_ucid = cpm.matter_ucid WHERE pm.matter_ucid > ? ORDER BY pm.matter_ucid ASC LIMIT ?`;
  const params    = isInitial ? [batchSize] : [cursor, batchSize];
  const [rows]    = await pool.query(query, params);
  if (!rows.length) return { docs: [], cursor };
  const docs      = await hydrateMatterRows(rows);
  return { docs, cursor: rows[rows.length - 1].matter_ucid };
}

// ─── MIGRATION LOG TABLE (MySQL Log DB) ──────────────────────────────────

async function initializeMigrationTable() {
  const pool = getLogPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migration_prod_logs (
        ucid      VARCHAR(255) PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        status    VARCHAR(20),
        whyfailed TEXT
      )
    `);
    mainLogger.info('MySQL migration_prod_logs table initialized.');
  } catch (err) {
    if (err.code === 'ER_TABLEACCESS_DENIED_ERROR' || err.message.includes('CREATE command denied')) {
      try {
        await pool.query('SELECT 1 FROM migration_prod_logs LIMIT 1');
        mainLogger.warn('Lacked CREATE privileges, but migration_prod_logs table already exists. Continuing.');
        return;
      } catch (selectErr) {
        mainLogger.error(`Table migration_prod_logs does not exist or is inaccessible: ${selectErr.message}`);
        throw selectErr;
      }
    }
    mainLogger.error(`Error initializing migration_prod_logs table: ${err.message}`);
    throw err;
  }
}

async function saveMigrationLogs(logs) {
  if (!logs || logs.length === 0) return;
  const pool   = getLogPool();
  const values = logs.map(log => [log.ucid, log.status, log.whyfailed || null]);
  try {
    await pool.query(
      `INSERT INTO migration_prod_logs (ucid, status, whyfailed) VALUES ?
       ON DUPLICATE KEY UPDATE status=VALUES(status), whyfailed=VALUES(whyfailed), timestamp=CURRENT_TIMESTAMP`,
      [values]
    );
  } catch (err) {
    mainLogger.error(`Error saving migration logs to MySQL: ${err.message}`);
  }
}

module.exports = {
  fetchBatch,
  fetchRange,
  fetchByUcids,
  computeCursorRanges,
  closePool,
  initializeMigrationTable,
  saveMigrationLogs,
};
