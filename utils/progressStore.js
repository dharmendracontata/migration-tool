const fs = require("fs");

const FILE     = "migration-progress.json";
const TMP_FILE = FILE + ".tmp";

const DEFAULTS = {
  completedRanges:   [],    // array of completed range indices
  totalRanges:       0,
  totalSaved:        0,
  totalFailed:       0,
  streamingComplete: false, // true once computeCursorRanges has finished fully
  rangeBoundaries:   null,  // cached so we don't re-query MySQL on restart
};

function saveProgress(state) {
  // Atomic write: temp file → rename (safe against mid-write crashes)
  fs.writeFileSync(TMP_FILE, JSON.stringify(state, null, 2));
  fs.renameSync(TMP_FILE, FILE);
}

function loadProgress() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // Detect old cursor-based format and ignore it
    if (data.cursor !== undefined && data.completedRanges === undefined) {
      return { ...DEFAULTS };
    }
    return {
      completedRanges:   data.completedRanges            || [],
      totalRanges:       data.totalRanges                || 0,
      totalSaved:        data.totalSaved                 || 0,
      totalFailed:       data.totalFailed                || 0,
      streamingComplete: data.streamingComplete           === true,
      rangeBoundaries:   data.rangeBoundaries            || null,
    };
  } catch (_err) {
    return { ...DEFAULTS };
  }
}

module.exports = { saveProgress, loadProgress };
