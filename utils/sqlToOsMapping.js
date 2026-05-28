const { mainLogger } = require('./logger');

/**
 * Direct mapping: MySQL public_matter column → OpenSearch field name + type.
 *
 * Suffixes determine the dynamic template that OpenSearch applies:
 *   _t  / _ts / _tr  → text
 *   _l  / _ls        → keyword
 *   _ds / _d  / _dr  → date
 *   _i  / _is        → integer
 *
 * A column can map to more than one OS field (e.g. patent_ucid → both _t and _l
 * so it is searchable as full-text AND filterable as a keyword).
 *
 * NOTE: Only columns that are listed in SELECTED_COLUMNS inside mySqlService.js
 * are actually fetched from MySQL. Any entry added here that is NOT in
 * SELECTED_COLUMNS will always receive undefined and will be silently skipped.
 */
const FIELD_MAP = {
  matter_ucid:                    [{ field: 'matter_ucid_t',                    type: 'keyword' }],
  title:                          [{ field: 'title_t',                          type: 'text'    }],
  title_lang:                     [{ field: 'title_lang_l',                     type: 'keyword' }],
  title_en:                       [{ field: 'title_en_t',                       type: 'text'    }],
  application_country:            [{ field: 'application_country_l',            type: 'keyword' }],
  serial_number:                  [{ field: 'serial_number_t',                  type: 'text'    }],
  matter_type:                    [{ field: 'matter_type_l',                    type: 'keyword' }],
  matter_status:                  [{ field: 'matter_status_l',                  type: 'keyword' }],
  filing_type:                    [{ field: 'filing_type_l',                    type: 'keyword' }],
  filing_date:                    [{ field: 'filing_date_ds',                   type: 'date'    }],
  parent_filing_date:             [{ field: 'parent_filing_date_d',             type: 'date'    }],
  pct_filing_date:                [{ field: 'pct_filing_date_d',                type: 'date'    }],
  national_entry_date:            [{ field: 'national_entry_date_d',            type: 'date'    }],
  grant_publication_date:         [{ field: 'grant_publication_date_ds',        type: 'date'    }],
  application_publication_date:   [{ field: 'application_publication_date_ds',  type: 'date'    }],
  priority_date:                  [{ field: 'priority_date_d',                  type: 'date'    }],
  claims_count:                   [{ field: 'claims_count_i',                   type: 'integer' }],
  independent_claims_count:       [{ field: 'independent_claims_count_i',       type: 'integer' }],
  all_claims_xml:                 [{ field: 'all_claims_t',                     type: 'text'    }],
  abstract:                       [{ field: 'abstract_text_t',                  type: 'text'    }],
  abstract_lang:                  [{ field: 'abstract_lang_l',                  type: 'keyword' }],
  abstract_en:                    [{ field: 'abstract_text_en_t',               type: 'text'    }],
  entity_size:                    [{ field: 'entity_size_l',                    type: 'keyword' }],
  patent_ucid:                    [{ field: 'patent_ucid_t',                    type: 'text'    },
                                   { field: 'patent_ucid_l',                    type: 'keyword' }],
  application_publication_ucid:   [{ field: 'application_publication_ucid_l',   type: 'keyword' }],
  local_registration_number:      [{ field: 'local_registration_number_t',      type: 'text'    }],
  parent_matter_ucid:             [{ field: 'parent_matter_ucid_t',             type: 'text'    }],
  description:                    [{ field: 'description_t',                    type: 'text'    }],
  grant_date:                     [{ field: 'grant_date_ds',                    type: 'date'    }],
  pendency_days:                  [{ field: 'pendency_days_i',                  type: 'integer' }],
  modified_on:                    [{ field: 'modified_on_dr',                   type: 'date'    }],
  allowance_date:                 [{ field: 'allowance_date_d',                 type: 'date'    }],
  complete_specification_date:    [{ field: 'complete_spec_date_d',             type: 'date'    }],
  request_examination_date:       [{ field: 'request_for_exam_date_d',          type: 'date'    }],
  // ── SCORE COLUMNS DYNAMICALLY COMPUTED ──────────────────────────────────────
  importance_score:            [{ field: 'importance_score_i',            type: 'integer' }],
  longevity_score:             [{ field: 'longevity_score_i',             type: 'integer' }],
  same_country_family_score:   [{ field: 'same_country_family_score_i',   type: 'integer' }],
  out_of_country_family_score: [{ field: 'out_of_country_family_score_i', type: 'integer' }],
  forward_citations_score:     [{ field: 'forward_citations_score_i',     type: 'integer' }],
  forward_citations_count:     [{ field: 'forward_citations_count_i',     type: 'integer' }],
};

/**
 * Strips XML tags from a string, following Java's dexmlify logic.
 */
function dexmlify(str) {
  if (!str) return '';
  // Basic implementation: remove anything between < and >
  return str.replace(/<[^>]*>/g, ' ').replace(/\s\s+/g, ' ').trim();
}

const MAX_DESCRIPTION_LENGTH = 20000;

// ─── display_serial_number logic ───────────────────────────────────────────

function calcDisplaySerialNumber(row) {
  const matterUcid = row.matter_ucid;
  if (!matterUcid) return null;

  if (matterUcid.startsWith('*')) {
    if (row.serial_number && row.serial_number.substring(0, 2) === 'EP') {
      return matterUcid.substring(1, 3) + '/' + calcDisplaySerialNumberForGeneralMatterUcid(row);
    } else {
      return matterUcid.substring(4, 6) + '/' + matterUcid.substring(1, 3) + '/' + calcDisplaySerialNumberForGeneralMatterUcid(row);
    }
  }

  if (matterUcid.endsWith('-W')) {
    const prefix = "PCT/" + matterUcid.substring(0, 2);
    if (row.pct_filing_date) {
      const filingDate = new Date(row.pct_filing_date);
      if (!isNaN(filingDate.getTime())) {
        const year = filingDate.getFullYear();
        if (matterUcid.length === 12) {
          let parsedSerial = matterUcid.substring(5, 10); // AT-0200217-W -> 00217
          while (parsedSerial.length < 6) parsedSerial = '0' + parsedSerial;
          return prefix + year + '/' + parsedSerial;
        }
        return prefix + year + '/' + matterUcid.substring(7, 13); // AT-2007000448-W -> 000448
      }
    }
  }

  return calcDisplaySerialNumberForGeneralMatterUcid(row);
}

function calcDisplaySerialNumberForGeneralMatterUcid(row) {
  const ucid = row.matter_ucid;
  if (!ucid) return null;

  const kind = ucid.charAt(ucid.length - 1);
  let suffix = '';
  switch (kind) {
    case 'A': suffix = ''; break;
    case 'F': suffix = '(D)'; break;
    default: suffix = '(' + kind + ')';
  }

  let base = row.serial_number || '';
  if (ucid.startsWith('US') && !base.startsWith('*')) {
    // Basic US serial formatting: split series and number if 8 digits
    if (base.length === 8 && /^\d+$/.test(base)) {
      const series = base.substring(0, 2);
      const num = base.substring(2);
      base = series + '/' + num.substring(0, 3) + ',' + num.substring(3);
    } else if (base.length <= 6 && /^\d+$/.test(base)) {
       // Just comma separator if only number
       if (base.length > 3) {
         base = base.substring(0, base.length - 3) + ',' + base.substring(base.length - 3);
       }
    }
  }

  return base + suffix;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toSafeDate(value, sqlCol, osField) {
  const d = value instanceof Date ? value : new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().split('.')[0] + 'Z';
  mainLogger.warn(`Skipping malformed date for ${sqlCol} -> ${osField}: ${JSON.stringify(value)}`);
  return null;
}

function toSafeInt(value, sqlCol, osField) {
  const n = parseInt(value, 10);
  if (!isNaN(n)) return n;
  mainLogger.warn(`Skipping malformed integer for ${sqlCol} -> ${osField}: ${JSON.stringify(value)}`);
  return null;
}

function getBreakpointIdx(value, breakpoints) {
  for (let i = breakpoints.length - 1; i >= 0; i--) {
    if (value >= breakpoints[i]) {
      return i;
    }
  }
  return 0;
}

function getYearsBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  let years = d2.getFullYear() - d1.getFullYear();
  if (d2.getMonth() < d1.getMonth() || (d2.getMonth() === d1.getMonth() && d2.getDate() < d1.getDate())) {
    years--;
  }
  return Math.max(0, years);
}

function calculateScores(row, familyMembers, forwardCitationInfo) {
  // same country family score
  const applicationCountry = row.application_country || '';
  const inCountryFamilyCount = familyMembers.filter(u => u.startsWith(applicationCountry)).length;
  const sameCountryFamily = getBreakpointIdx(inCountryFamilyCount, [0, 1, 2, 3, 4, 5]);

  // out of country family score
  const outOfCountryFamilyCount = familyMembers.length - inCountryFamilyCount;
  const outOfCountryFamily = getBreakpointIdx(outOfCountryFamilyCount, [0, 1, 3, 4, 5, 9]);

  // longevity score
  const endDate = new Date();
  const filingDate = row.filing_date ? new Date(row.filing_date) : endDate;
  const priorityDate = row.priority_date ? new Date(row.priority_date) : filingDate;

  const filingYears = getYearsBetween(filingDate, endDate);
  const priorityYears = getYearsBetween(priorityDate, endDate);
  const avgLongevityYears = Math.floor((filingYears + priorityYears) / 2);
  const longevity = getBreakpointIdx(avgLongevityYears, [0, 3, 5, 7, 10, 16]);

  // forward citations score & count
  let forwardCitationCount = 0;
  let forwardCitations = 0;
  if (row.patent_ucid && forwardCitationInfo) {
    forwardCitationCount = forwardCitationInfo.count || 0;
    const combinedForwardCitationCount = forwardCitationCount + (forwardCitationInfo.countExa || 0);
    forwardCitations = getBreakpointIdx(combinedForwardCitationCount, [0, 1, 6, 16, 25, 50]);
  }

  // importance score
  const sameCountryFamilyFactor = 1 + Math.floor(sameCountryFamily / 3);
  const forwardCitationsFactor = 1 + Math.floor(forwardCitations / 3);
  
  const numerator = (sameCountryFamilyFactor * sameCountryFamily)
                  + outOfCountryFamily
                  + (2 * longevity)
                  + (forwardCitationsFactor * forwardCitations);
                  
  const denominator = 5 + Math.floor(sameCountryFamilyFactor / 2) + Math.floor(forwardCitationsFactor / 2);
  
  const importance = Math.floor(numerator / denominator);

  return {
    importance_score_i: importance,
    longevity_score_i: longevity,
    same_country_family_score_i: sameCountryFamily,
    out_of_country_family_score_i: outOfCountryFamily,
    forward_citations_score_i: forwardCitations,
    forward_citations_count_i: forwardCitationCount
  };
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Maps a single MySQL row from public_matter (potentially enriched with _parties, _documents, etc.)
 * directly to a flat OpenSearch document object ready for bulk indexing.
 */
function mapSqlRowToOpenSearch(row) {
  // 1. Calculate scores and attach to the row for standard column mapping
  const scores = calculateScores(row, row._familyMatters || [], row._forwardCitationInfo);
  Object.assign(row, {
    importance_score:            scores.importance_score_i,
    longevity_score:             scores.longevity_score_i,
    same_country_family_score:   scores.same_country_family_score_i,
    out_of_country_family_score: scores.out_of_country_family_score_i,
    forward_citations_score:     scores.forward_citations_score_i,
    forward_citations_count:     scores.forward_citations_count_i,
  });

  const doc = {};

  // 2. Process standard columns
  mapStandardColumns(row, doc);

  // 3. Calculated fields
  const displaySN = calcDisplaySerialNumber(row);
  if (displaySN) doc.display_serial_number_t = displaySN;

  // 4. Process Child Data
  if (row._parties)           mapParties(row._parties, doc);
  if (row._documents)         mapDocuments(row._documents, doc, row);
  if (row._citations)         mapCitations(row._citations, doc);
  if (row._priorities)        mapPriorities(row._priorities, doc);
  if (row._classifications)    mapClassifications(row._classifications, doc);
  if (row._familyMatters)      mapFamilyMatters(row._familyMatters, doc);
  if (row._epCountries)        mapEpCountries(row._epCountries, doc);
  if (row._legalStatusEvents) mapLegalStatusEvents(row._legalStatusEvents, doc);

  return doc;
}

function mapStandardColumns(row, doc) {
  for (const [sqlCol, targets] of Object.entries(FIELD_MAP)) {
    const raw = row[sqlCol];
    if (raw === undefined || raw === null) continue;

    for (const { field, type } of targets) {
      let value;
      switch (type) {
        case 'date':    value = toSafeDate(raw, sqlCol, field); break;
        case 'integer': value = toSafeInt(raw, sqlCol, field);  break;
        default: 
          value = raw instanceof Date ? raw.toISOString().split('.')[0] + 'Z' : String(raw);
          // Dexmlify specific fields
          if (['all_claims_t', 'abstract_text_t', 'abstract_text_en_t', 'description_t'].includes(field)) {
            value = dexmlify(value);
            if (field === 'description_t') {
              value = value.substring(0, MAX_DESCRIPTION_LENGTH);
            }
          }
      }
      if (value !== null) doc[field] = value;
    }
  }
}

function mapParties(parties, doc) {
  const partyTypes = {
    AGENT:               { name: 'agent_names_ta',         country: 'agent_countries_la',         address: 'agent_addresses_ta' },
    APPLICANT:           { name: 'applicant_names_ta',     country: 'applicant_countries_la',     address: 'applicant_addresses_ta' },
    ASSIGNEE:            { name: 'original_assignee_names_ta', country: 'original_assignee_countries_la', address: 'original_assignee_addresses_ta' },
    CURRENT_ASSIGNEE:    { name: 'current_assignee_names_ta',  country: 'current_assignee_countries_la',  address: 'current_assignee_addresses_ta' },
    HISTORICAL_ASSIGNEE: { name: 'historical_assignee_names_ta', country: 'historical_assignee_countries_la', address: 'historical_assignee_addresses_ta' },
    EXAMINER:            { name: 'examiner_names_ta',      country: 'examiner_countries_la',      address: 'examiner_addresses_ta' },
    INVENTOR:            { name: 'inventor_names_ta',      country: 'inventor_countries_la',      address: 'inventor_addresses_ta' },
  };

  for (const p of parties) {
    const target = partyTypes[p.party_type];
    if (!target) continue;

    doc[target.name]    = doc[target.name]    || [];
    doc[target.country] = doc[target.country] || [];
    doc[target.address] = doc[target.address] || [];

    doc[target.name].push(p.party_std_name);
    doc[target.country].push(p.party_country || '');
    doc[target.address].push(p.party_address || '');

    if (p.party_type === 'CURRENT_ASSIGNEE') {
      doc.current_assignee_facet_names_la = doc.current_assignee_facet_names_la || [];
      doc.current_assignee_facet_names_la.push(p.party_std_name);
    }
  }
}

function mapDocuments(documents, doc, parentRow) {
  if (!documents.length) return;
  doc.document_ucids_ta = [];
  doc.document_types_la = [];
  doc.document_publish_dates_da = [];

  for (const d of documents) {
    doc.document_ucids_ta.push(d.publication_ucid);
    if (d.document_type) doc.document_types_la.push(d.document_type);

    let pubDate = null;
    if (d.document_type === 'Grant Publication' && parentRow.grant_publication_date) {
      pubDate = parentRow.grant_publication_date;
    } else if (parentRow.application_publication_date) {
      pubDate = parentRow.application_publication_date;
    }

    if (pubDate) {
      const formattedDate = toSafeDate(pubDate, 'document_publish_dates_da', 'document_publish_dates_da');
      if (formattedDate) {
        doc.document_publish_dates_da.push(formattedDate);
      }
    }
  }

  if (!doc.document_publish_dates_da.length) {
    delete doc.document_publish_dates_da;
  }
}

function mapCitations(citations, doc) {
  doc.cited_publication_ucids_ta = [];
  doc.citation_source_names_ta = [];
  for (const c of citations) {
    doc.cited_publication_ucids_ta.push(c.cited_publication_ucid);
    doc.citation_source_names_ta.push(c.source_name || '');
  }
}

function mapPriorities(priorities, doc) {
  doc.priority_claim_matters_ta = [];
  doc.priority_claim_filing_dates_da = [];
  for (const p of priorities) {
    doc.priority_claim_matters_ta.push(p.claimed_matter_ucid);
    const d = toSafeDate(p.claimed_matter_filing_date, 'priority_date', 'priority_claim_filing_dates_da');
    if (d) doc.priority_claim_filing_dates_da.push(d);
  }
}

function mapClassifications(classifications, doc) {
  const ipc = [], cpc = [], ecla = [], fos = [];
  for (const c of classifications) {
    const code = c.classification_code;
    if (!code) continue;
    switch ((c.classification_code_type || '').toLowerCase()) {
      case 'ipc':                 ipc.push(code);  break;
      case 'cpc':                 cpc.push(code);  break;
      case 'ecla':                ecla.push(code); break;
      case 'ipc_field_of_search':  fos.push(code); break;
    }
  }
  if (ipc.length)  doc.ipc_classifications_ta = ipc;
  if (cpc.length) {
    doc.cpc_classifications_ta = cpc;
    const techSet = new Set(cpc.map(c => c.replace(/ .*$/, '').substring(0, 4)));
    if (techSet.size) doc.technology_classifications_la = [...techSet];
  }
  if (ecla.length) doc.ecla_classifications_ta = ecla;
  if (fos.length)  doc.ipc_field_of_search_classifications_ta = fos;
}

function mapFamilyMatters(familyMatters, doc) {
  if (familyMatters.length) doc.family_matters_ta = familyMatters;
}

function mapEpCountries(epCountries, doc) {
  const codes = [], statuses = [], statusTypes = [], statusDates = [], feeDates = [], refUcids = [];
  for (const ep of epCountries) {
    if (ep.designated_country) codes.push(ep.designated_country);
    if (ep.status)             statuses.push(ep.status);
    if (ep.status_type)        statusTypes.push(ep.status_type);
    if (ep.status_date) {
      const d = toSafeDate(ep.status_date, 'status_date', 'ep_designated_country_status_dates_da');
      if (d) statusDates.push(d);
    }
    if (ep.fee_payment_date) {
      const d = toSafeDate(ep.fee_payment_date, 'fee_payment_date', 'ep_designated_country_fee_payment_dates_da');
      if (d) feeDates.push(d);
    }
    if (ep.designated_country_matter_ucid) refUcids.push(ep.designated_country_matter_ucid);
  }
  if (codes.length)       doc.ep_designated_country_codes_la             = codes;
  if (statuses.length)    doc.ep_designated_country_statuses_la          = statuses;
  if (statusTypes.length)  doc.ep_designated_country_status_types_la      = statusTypes;
  if (statusDates.length)  doc.ep_designated_country_status_dates_da       = statusDates;
  if (feeDates.length)    doc.ep_designated_country_fee_payment_dates_da = feeDates;
  if (refUcids.length)    doc.ep_designated_country_ref_matter_ucids_ta  = refUcids;
}

function mapLegalStatusEvents(events, doc) {
  if (!events.length) return;
  doc.legal_status_event_codes_la = [];
  doc.legal_status_event_countries_la = [];
  doc.legal_status_event_dates_of_public_notification_da = [];
  
  for (const e of events) {
    if (e.code) doc.legal_status_event_codes_la.push(e.code);
    if (e.country) doc.legal_status_event_countries_la.push(e.country);
    if (e.date_of_public_notification) {
      const d = toSafeDate(e.date_of_public_notification, 'date_of_public_notification', 'legal_status_event_dates_of_public_notification_da');
      if (d) doc.legal_status_event_dates_of_public_notification_da.push(d);
    }
  }
}

module.exports = { mapSqlRowToOpenSearch };
