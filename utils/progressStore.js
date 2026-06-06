const fs = require("fs");

const PROGRESS_FILE = "migration-progress.json";
const PROGRESS_TMP  = PROGRESS_FILE + ".tmp";

const RANGES_FILE   = "migration-ranges.json";
const RANGES_TMP    = RANGES_FILE + ".tmp";

const DEFAULTS = {
  completedRanges:   [],    // array of completed range indices
  totalRanges:       0,
  totalSaved:        0,
  totalFailed:       0,
  streamingComplete: false, // true once computeCursorRanges has finished fully
  rangeBoundaries:   null,  // cached so we don't re-query MySQL on restart
};

function saveProgress(state, writeRanges = false) {
  // 1. Save small dynamic progress state (compact JSON, no formatting)
  const progressState = {
    completedRanges:   state.completedRanges,
    totalRanges:       state.totalRanges,
    totalSaved:        state.totalSaved,
    totalFailed:       state.totalFailed,
    streamingComplete: state.streamingComplete,
  };
  fs.writeFileSync(PROGRESS_TMP, JSON.stringify(progressState));
  fs.renameSync(PROGRESS_TMP, PROGRESS_FILE);

  // 2. Save range boundaries only if explicitly requested and boundaries are provided
  if (writeRanges && state.rangeBoundaries) {
    fs.writeFileSync(RANGES_TMP, JSON.stringify(state.rangeBoundaries));
    fs.renameSync(RANGES_TMP, RANGES_FILE);
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    // Detect old cursor-based format and ignore it
    if (data.cursor !== undefined && data.completedRanges === undefined) {
      return { ...DEFAULTS };
    }

    // Load range boundaries.
    // Try to load from migration-ranges.json first.
    // If not present, fallback to checking if it is embedded in the old migration-progress.json.
    let rangeBoundaries = null;
    if (fs.existsSync(RANGES_FILE)) {
      try {
        rangeBoundaries = JSON.parse(fs.readFileSync(RANGES_FILE, "utf8"));
      } catch (_) {
        // ignore and fallback
      }
    }
    if (!rangeBoundaries && data.rangeBoundaries) {
      rangeBoundaries = data.rangeBoundaries;
    }

    return {
      completedRanges:   data.completedRanges            || [],
      totalRanges:       data.totalRanges                || (rangeBoundaries ? rangeBoundaries.length : 0),
      totalSaved:        data.totalSaved                 || 0,
      totalFailed:       data.totalFailed                || 0,
      streamingComplete: data.streamingComplete           === true,
      rangeBoundaries:   rangeBoundaries,
    };
  } catch (_err) {
    return { ...DEFAULTS };
  }
}

module.exports = { saveProgress, loadProgress };
