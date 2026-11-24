const flowEngine = require('./flowEngine');
const logger = require('../utils/logger');

const TICK_MS = 15000;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await flowEngine.processDueRuns();
  } catch (err) {
    logger.error('flowScheduler: tick falhou:', err);
  } finally {
    ticking = false;
  }
}

function startFlowScheduler() {
  setInterval(tick, TICK_MS);
}

module.exports = { startFlowScheduler };
