if (!Object.hasOwn) {
  Object.hasOwn = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
}

const fs = require('fs');
require('dotenv').config();
const { computeCursorRanges, closePool } = require('./services/mySqlService');

async function expand() {
  const FILE = 'migration-progress.json';
  if (!fs.existsSync(FILE)) {
    console.error('No progress file found to expand!');
    process.exit(1);
  }
  const progress = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  console.log(`Current progress: ${progress.completedRanges.length} completed ranges of ${progress.totalRanges} total.`);

  console.log('Computing new range boundaries...');
  const newRanges = await computeCursorRanges(parseInt(process.env.BATCH_SIZE) || 1000);
  
  progress.rangeBoundaries = newRanges;
  progress.totalRanges = newRanges.length;
  
  fs.writeFileSync(FILE, JSON.stringify(progress, null, 2));
  console.log(`Successfully expanded progress file to ${newRanges.length} ranges. Resuming will start from range #20.`);
}

expand()
  .catch(console.error)
  .finally(() => closePool());
