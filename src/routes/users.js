const express = require('express');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { hashPassword } = require('../utils/password');
const { colorForIndex } = require('../utils/colorPalette');

const router = express.Router();

const VALID_ROLES = ['admin', 'agent'];

const listStmt = db.prepare(
  'SELECT id, username, name, role, color, is_active, created_at FROM users ORDER BY name'
);
const getStmt = db.prepare('SELECT id, username, name, role, color, is_active FROM users WHERE id = ?');
const countUsersStmt = db.prepare('SELECT COUNT(*) AS count FROM users');
const insertStmt = db.prepare(
  'INSERT INTO users (username, password_hash, name, role, color) VALUES (?, ?, ?, ?, ?)'
);
const updateStmt = db.prepare(
  "UPDATE users SET name = ?, role = ?, color = ?, updated_at = now() WHERE id = ?"
);
const updatePasswordStmt = db.prepare(
  "UPDATE users SET password_hash = ?, updated_at = now() WHERE id = ?"
);
const setActiveStmt = db.prepare(
  "UPDATE users SET is_active = ?, updated_at = now() WHERE id = ?"
);
const countActiveAdminsStmt = db.prepare(
  "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1"
);

async function isLastActiveAdmin(user) {
  if (user.role !== 'admin' || !user.is_active) return false;
  return (await countActiveAdminsStmt.get()).count <= 1;
}

router.get('/', async (req, res) => {
  res.json(await listStmt.all());
});

router.post('/', requireAdmin, async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name) {
    return res.status(400).json({ error: 'username, password e name são obrigatórios.' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role deve ser um de: ${VALID_ROLES.join(', ')}` });
  }

  const color = colorForIndex((await countUsersStmt.get()).count);

  try {
    const result = await insertStmt.run(username, hashPassword(password), name, role, color);
    res.status(201).json(await getStmt.get(Number(result.lastInsertRowid)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: `Já existe um usuário com o username "${username}".` });
    }
    throw err;
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const user = await getStmt.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const { name, role, password, color } = req.body || {};
  const nextRole = role || user.role;
  if (!VALID_ROLES.includes(nextRole)) {
    return res.status(400).json({ error: `role deve ser um de: ${VALID_ROLES.join(', ')}` });
  }
  if (nextRole !== 'admin' && await isLastActiveAdmin(user)) {
    return res.status(409).json({ error: 'Não é possível rebaixar o último administrador ativo.' });
  }

  await updateStmt.run(name || user.name, nextRole, color || user.color, req.params.id);
  if (password) {
    await updatePasswordStmt.run(hashPassword(password), req.params.id);
  }
  res.json(await getStmt.get(req.params.id));
});

router.patch('/:id/deactivate', requireAdmin, async (req, res) => {
  const user = await getStmt.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (await isLastActiveAdmin(user)) {
    return res.status(409).json({ error: 'Não é possível desativar o último administrador ativo.' });
  }
  await setActiveStmt.run(0, req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/activate', requireAdmin, async (req, res) => {
  const user = await getStmt.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  await setActiveStmt.run(1, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
