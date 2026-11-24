const fs = require('node:fs');
const path = require('node:path');

// Módulo de marketing (RF01–RF11). As tabelas vêm no esquema base; aqui ficam
// as visões e os gatilhos, aplicados depois porque dependem delas.

async function applyMarketingMigrations(db) {
  const views = fs.readFileSync(path.join(__dirname, 'schema-views.sql'), 'utf8');
  await db.exec(views);
  console.log('Módulo de marketing: visões e gatilhos aplicados.');
}

module.exports = { applyMarketingMigrations };
