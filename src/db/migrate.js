require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const { colorForIndex } = require('../utils/colorPalette');
const { applyMarketingMigrations } = require('./migrate-marketing');

// Migração idempotente: pode ser executada quantas vezes for necessário.
// O esquema base cria o que falta; os ajustes seguintes cobrem bancos que já
// existiam antes de cada mudança.

const ler = (arquivo) => fs.readFileSync(path.join(__dirname, arquivo), 'utf8');

async function colunasDe(tabela) {
  const linhas = await db
    .prepare('SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?')
    .all(tabela);
  return linhas.map((l) => l.name);
}

async function adicionarColuna(tabela, nome, definicao) {
  if ((await colunasDe(tabela)).includes(nome)) return false;
  await db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${definicao}`);
  console.log(`Coluna ${tabela}.${nome} adicionada.`);
  return true;
}

async function migrar() {
  await db.exec(ler('schema.sql'));

  await adicionarColuna('conversations', 'assigned_user_id', 'INTEGER REFERENCES users(id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(assigned_user_id)');

  await adicionarColuna('users', 'color', "TEXT NOT NULL DEFAULT '#999999'");

  // Dá uma cor distinta pra cada usuário que ainda está no cinza padrão.
  const semCor = await db.prepare("SELECT id FROM users WHERE color = '#999999' ORDER BY id").all();
  if (semCor.length > 1) {
    for (let i = 0; i < semCor.length; i += 1) {
      await db.prepare('UPDATE users SET color = ? WHERE id = ?').run(colorForIndex(i), semCor[i].id);
    }
    console.log(`Cores atribuídas a ${semCor.length} usuário(s) existente(s).`);
  }

  await adicionarColuna('messages', 'origin', "TEXT CHECK (origin IN ('human','bot','ai'))");

  await applyMarketingMigrations(db);

  console.log('Migração aplicada com sucesso.');
  await db.close();
}

migrar().catch((err) => {
  console.error('Falha na migração:', err.message);
  process.exit(1);
});
