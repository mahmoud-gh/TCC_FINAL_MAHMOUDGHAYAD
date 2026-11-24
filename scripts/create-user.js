(async () => {
require('dotenv').config();
const db = require('../src/db');
const { hashPassword } = require('../src/utils/password');
const { colorForIndex } = require('../src/utils/colorPalette');

const [username, password, name, role = 'agent'] = process.argv.slice(2);

if (!username || !password || !name) {
  console.error('Uso: node scripts/create-user.js <username> <senha> "<nome>" [admin|agent]');
  process.exit(1);
}
if (!['admin', 'agent'].includes(role)) {
  console.error('role deve ser "admin" ou "agent".');
  process.exit(1);
}

const insertStmt = db.prepare(
  'INSERT INTO users (username, password_hash, name, role, color) VALUES (?, ?, ?, ?, ?)'
);
const countUsersStmt = db.prepare('SELECT COUNT(*) AS count FROM users');

try {
  const color = colorForIndex((await countUsersStmt.get()).count);
  const result = await insertStmt.run(username, hashPassword(password), name, role, color);
  console.log(`Usuário "${username}" criado (id ${Number(result.lastInsertRowid)}, role ${role}).`);
} catch (err) {
  if (String(err.message).includes('UNIQUE')) {
    console.error(`Já existe um usuário com o username "${username}".`);
    process.exit(1);
  }
  throw err;
}

await db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
