const express = require('express');
const db = require('../db');
const { verifyPassword } = require('../utils/password');

const router = express.Router();

const getUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserByIdStmt = db.prepare(
  'SELECT id, username, name, role FROM users WHERE id = ? AND is_active = 1'
);

// Hash com o mesmo formato "salt:hash" de hashPassword — garante que verifyPassword sempre
// rode o scrypt (custo constante), mesmo se o usuário não existir, evitando enumeração por tempo.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await getUserByUsernameStmt.get(username || '');
  const passwordOk = verifyPassword(password || '', (user && user.password_hash) || DUMMY_HASH);

  if (!user || !user.is_active || !passwordOk) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Falha ao criar sessão.' });
    req.session.userId = user.id;
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, name: user.name, role: user.role },
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', async (req, res) => {
  const userId = req.session && req.session.userId;
  const user = userId ? await getUserByIdStmt.get(userId) : null;
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user });
});

module.exports = router;
