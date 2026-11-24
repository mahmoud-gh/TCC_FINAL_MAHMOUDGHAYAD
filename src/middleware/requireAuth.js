const db = require('../db');

const getUserByIdStmt = db.prepare(
  'SELECT id, username, name, role, is_active FROM users WHERE id = ?'
);

async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const user = await getUserByIdStmt.get(req.session.userId);
  if (!user || !user.is_active) {
    return req.session.destroy(() => res.status(401).json({ error: 'Não autenticado.' }));
  }

  req.user = user;
  next();
}

module.exports = requireAuth;
