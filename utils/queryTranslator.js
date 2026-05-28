/**
 * Translates BHIP/PatentBuddy-style "full text" queries into CloudSearch-compatible Lucene Classic queries.
 * BHIP field names are translated into our field names and some search values (like dates) are transformed.
 * This is a direct Node.js port of the BhipQueryTranslator.java
 */

const LUCENE_SPECIAL_CHARS_EXCEPT_DBL_QUOTE = '+&|!(){}[]^~*?:/';
const LUCENE_SPECIAL_CHARS = LUCENE_SPECIAL_CHARS_EXCEPT_DBL_QUOTE + '"';
const NOT_SUPPORTED = null;

// Matches a 2+ character search field name, followed by a colon, and not followed by a Lucene special character other than double-quote.
const SEARCH_FIELD_PATTERN = /[a-z][a-zA-Z0-9_]+:/g;

function dateOnly(dateStr) {
    if (!dateStr || dateStr.trim() === '*') return dateStr;
    const START_OF_DAY_TIME = "T00:00:00.000Z";
    const END_OF_DAY_TIME = "T23:59:59.999Z";

    let unquotedValue = dateStr;
    if (dateStr.startsWith('"') && dateStr.endsWith('"') && dateStr.length >= 2) {
        unquotedValue = dateStr.substring(1, dateStr.length - 1);
    }

    if (/^\d{8}$/.test(unquotedValue)) {
        const reformatted = unquotedValue.substring(0, 4) + "-" + unquotedValue.substring(4, 6) + "-" + unquotedValue.substring(6, 8);
        return "[" + reformatted + START_OF_DAY_TIME + " TO " + reformatted + END_OF_DAY_TIME + "]";
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(unquotedValue)) {
        return "[" + unquotedValue + START_OF_DAY_TIME + " TO " + unquotedValue + END_OF_DAY_TIME + "]";
    }

    if (/^\d{4}$/.test(unquotedValue)) {
        return "[" + unquotedValue + "-01-01" + START_OF_DAY_TIME + " TO " + unquotedValue + "-12-31" + END_OF_DAY_TIME + "]";
    }

    return dateStr;
}

const BHIP_QUERY_FIELD_MAPPING = [
    { bhipFieldName: "ttl", cloudSearchFieldName: "title_t", alternateCloudSearchFieldName: "title_en_t", transformFunc: null },
    { bhipFieldName: "ab", cloudSearchFieldName: "abstract_text_t", alternateCloudSearchFieldName: "abstract_text_en_t", transformFunc: null },
    { bhipFieldName: "desc", cloudSearchFieldName: "description_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "aclm", cloudSearchFieldName: "all_claims_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "clm", cloudSearchFieldName: "all_claims_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ad", cloudSearchFieldName: "filing_date_ds", alternateCloudSearchFieldName: null, transformFunc: dateOnly },
    { bhipFieldName: "adyear", cloudSearchFieldName: "filing_date_ds", alternateCloudSearchFieldName: null, transformFunc: dateOnly },
    { bhipFieldName: "pd", cloudSearchFieldName: "grant_publication_date_ds", alternateCloudSearchFieldName: null, transformFunc: dateOnly },
    { bhipFieldName: "pdyear", cloudSearchFieldName: "grant_publication_date_ds", alternateCloudSearchFieldName: null, transformFunc: dateOnly },
    { bhipFieldName: "prid", cloudSearchFieldName: "priority_date_d", alternateCloudSearchFieldName: null, transformFunc: dateOnly },
    { bhipFieldName: "pn", cloudSearchFieldName: "patent_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pnctry", cloudSearchFieldName: "patent_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pnnum", cloudSearchFieldName: "patent_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pnkind", cloudSearchFieldName: "patent_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pnlang", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "an", cloudSearchFieldName: "matter_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "annum", cloudSearchFieldName: "serial_number_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "anctry", cloudSearchFieldName: "matter_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ankind", cloudSearchFieldName: "matter_ucid_t", alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "anlang", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    
    // PCT Fields missing, correspondent, non-patent citations are NOT_SUPPORTED
    { bhipFieldName: "pctan", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctanctry", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctannum", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctankind", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpn", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpnctry", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpnnum", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpnkind", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpd", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pctpdyear", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "cor", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "pcitrel", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ncit", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ncitrel", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ncitsrc", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "ncittxt", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    
    // rel* fields
    { bhipFieldName: "relan", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relankind", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relanctry", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relannum", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relad", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "reladyear", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpn", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpnkind", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpnctry", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpnnum", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpd", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null },
    { bhipFieldName: "relpdyear", cloudSearchFieldName: NOT_SUPPORTED, alternateCloudSearchFieldName: null, transformFunc: null }
];


const bhipQueryFieldNameToMapping = new Map();
BHIP_QUERY_FIELD_MAPPING.forEach(mapping => {
    bhipQueryFieldNameToMapping.set(mapping.bhipFieldName, mapping);
});

function findQuotedValueEndIdx(bhipQuery, valueStartIdx) {
    let prevChar = 0;
    let endIdx = valueStartIdx + 1;
    for (; endIdx < bhipQuery.length; endIdx++) {
        const c = bhipQuery.charAt(endIdx);
        if (prevChar !== '\\' && c === '"') {
            endIdx++;
            break;
        }
        prevChar = c;
    }
    return endIdx;
}

function findValueEndIdx(bhipQuery, valueStartIdx) {
    let prevChar = 0;
    let endIdx = valueStartIdx;
    for (; endIdx < bhipQuery.length; endIdx++) {
        const c = bhipQuery.charAt(endIdx);
        // Is whitespace or is Lucene special char
        const isWhitespace = /\s/.test(c);
        if (prevChar !== '\\' && (isWhitespace || LUCENE_SPECIAL_CHARS.indexOf(c) >= 0)) {
            // Note: Unlike java wait we don't increment unless we found end? Java does: `break` without increment, wait let's check Java code:
            // if (...) { ++endIdx; break; } -> Wait, java DID increment. Let's look at java snippet:
            // if (prevChar != '\\' && (Character.isWhitespace(c) || LUCENE_SPECIAL_CHARS.indexOf(c) >= 0)) { break; }
            // Wait, actually Java snippet says:
            // if (prevChar != '\\' && (Character.isWhitespace(c) || ...)) { ++endIdx; break; } -> Wait! No, let's verify.
            // Oh, but Java does substring(valueStartIdx, valueEndIdx). The valueEndIdx is EXCLUSIVE in java substring.
            // Wait, in Java, string substring(int beginIndex, int endIndex). If it increments and then breaks, the special char or space is INCLUDED!
            // Let's re-read Java logic for valueEndIdx: wait. If I search until whitespace, I DON'T want the whitespace included in the value mapping. 
            // In Java, it was:
            /*
            int endIdx = valueStartIdx;
            for (; endIdx < bhipQuery.length(); endIdx++) {
                final char c = bhipQuery.charAt(endIdx);
                if (prevChar != '\\' && (Character.isWhitespace(c) || LUCENE_SPECIAL_CHARS.indexOf(c) >= 0)) {
                    // ++endIdx; break; wait let me look at line 489.
                    break;
                }
                prevChar = c;
            }
            */
            break;
        }
        prevChar = c;
    }
    return endIdx;
}

function processQueryString(bhipQuery, useAlternateMapping) {
    let translatedQuery = '';
    let usedFieldWithAlternateMapping = false;
    let startIdx = 0;

    SEARCH_FIELD_PATTERN.lastIndex = 0; // Reset regex
    let matcher;

    while ((matcher = SEARCH_FIELD_PATTERN.exec(bhipQuery)) !== null) {
        const fieldStartIdx = matcher.index;
        const fieldEndIdx = SEARCH_FIELD_PATTERN.lastIndex; // index after the colon
        
        // Extract field name without colon
        const fieldName = bhipQuery.substring(fieldStartIdx, fieldEndIdx - 1);
        
        let mapping = bhipQueryFieldNameToMapping.get(fieldName);
        
        if (!mapping || mapping.cloudSearchFieldName === NOT_SUPPORTED) {
            console.error("Unsupported CloudSearch field detected in Request: " + fieldName + " for bhip query: " + bhipQuery);
            mapping = { bhipFieldName: "null", cloudSearchFieldName: "null_t", alternateCloudSearchFieldName: null, transformFunc: null };
        }

        // Everything before this field match goes in as is
        translatedQuery += bhipQuery.substring(startIdx, fieldStartIdx);

        const hasAlternateMapping = mapping.alternateCloudSearchFieldName != null;
        usedFieldWithAlternateMapping = usedFieldWithAlternateMapping || hasAlternateMapping;

        const mappedFieldName = (useAlternateMapping && hasAlternateMapping) 
            ? mapping.alternateCloudSearchFieldName 
            : mapping.cloudSearchFieldName;
            
        translatedQuery += mappedFieldName + ':';

        const valueStartIdx = fieldEndIdx;
        if (valueStartIdx === bhipQuery.length) {
            startIdx = valueStartIdx;
            continue;
        }

        const firstValueChar = bhipQuery.charAt(valueStartIdx);
        // Don't form map for [TO] bracket syntax
        if (LUCENE_SPECIAL_CHARS_EXCEPT_DBL_QUOTE.indexOf(firstValueChar) >= 0) {
            startIdx = valueStartIdx;
            continue;
        }

        const valueEndIdx = (firstValueChar === '"') 
            ? findQuotedValueEndIdx(bhipQuery, valueStartIdx) 
            : findValueEndIdx(bhipQuery, valueStartIdx);

        let value = bhipQuery.substring(valueStartIdx, valueEndIdx);
        if (mapping.transformFunc) {
            value = mapping.transformFunc(value);
        }

        translatedQuery += value;
        startIdx = valueEndIdx;
    }

    translatedQuery += bhipQuery.substring(startIdx);

    return {
        translatedQuery,
        usedFieldWithAlternateMapping
    };
}

/**
 * Translates BHIP/PatentBuddy-style "full text" queries into CloudSearch/OpenSearch Lucene queries.
 * @param {string} bhipQuery The human query
 * @returns {string} The translated query
 */
function translateQuery(bhipQuery) {
    if (!bhipQuery) return bhipQuery;

    const result = processQueryString(bhipQuery, false);
    if (result.usedFieldWithAlternateMapping) {
        const result2 = processQueryString(bhipQuery, true);
        return "(" + result.translatedQuery + ") OR (" + result2.translatedQuery + ")";
    }

    return result.translatedQuery;
}

module.exports = {
    translateQuery,
    LUCENE_SPECIAL_CHARS,
    LUCENE_SPECIAL_CHARS_EXCEPT_DBL_QUOTE,
    BHIP_QUERY_FIELD_MAPPING
};
