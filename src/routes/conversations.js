const express = require('express');
const db = require('../db');
const { loadVisibleConversation } = require('../services/conversationAccess');
const { broadcast } = require('../services/sse');

const router = express.Router();

const listAllStmt = db.prepare(`
  SELECT
    c.id, c.platform, c.status, c.unread_count, c.last_message_at, c.window_expires_at,
    c.assigned_user_id, u.name AS assigned_user_name, u.color AS assigned_user_color,
    ct.id AS contact_id, ct.display_name, ct.phone, ct.profile_pic_url
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assigned_user_id
  ORDER BY c.last_message_at DESC
`);

const listVisibleStmt = db.prepare(`
  SELECT
    c.id, c.platform, c.status, c.unread_count, c.last_message_at, c.window_expires_at,
    c.assigned_user_id, u.name AS assigned_user_name, u.color AS assigned_user_color,
    ct.id AS contact_id, ct.display_name, ct.phone, ct.profile_pic_url
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assigned_user_id
  WHERE c.assigned_user_id = ? OR c.assigned_user_id IS NULL
  ORDER BY c.last_message_at DESC
`);

const updateStatusStmt = db.prepare(`
  UPDATE conversations SET status = ?, updated_at = now() WHERE id = ?
`);

const clearUnreadStmt = db.prepare(`
  UPDATE conversations SET unread_count = 0 WHERE id = ?
`);

const assignStmt = db.prepare(`
  UPDATE conversations SET assigned_user_id = ?, updated_at = now() WHERE id = ?
`);

const getActiveUserStmt = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1');

const tagsForConversationStmt = db.prepare(`
  SELECT t.id, t.name, t.color
  FROM tags t
  JOIN conversation_tags ct ON ct.tag_id = t.id
  WHERE ct.conversation_id = ?
`);

const notesForConversationStmt = db.prepare(`
  SELECT id, body, created_at FROM notes WHERE conversation_id = ? ORDER BY created_at DESC
`);

const listTagsStmt = db.prepare(`SELECT id, name, color FROM tags ORDER BY name`);
const insertTagStmt = db.prepare(`INSERT INTO tags (name, color) VALUES (?, ?)`);
const linkTagStmt = db.prepare(`INSERT INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`);
const unlinkTagStmt = db.prepare(`DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?`);
const insertNoteStmt = db.prepare(`INSERT INTO notes (conversation_id, body) VALUES (?, ?)`);

const VALID_STATUSES = ['novo', 'em_conversa', 'orcamento_enviado', 'fechado', 'perdido'];

router.get('/', async (req, res) => {
  const rows = req.user.role === 'admin' ? await listAllStmt.all() : await listVisibleStmt.all(req.user.id);
  res.json(rows);
});

router.get('/tags', async (req, res) => {
  res.json(await listTagsStmt.all());
});

router.post('/tags', async (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name é obrigatório.' });
  const result = await insertTagStmt.run(name, color || '#999999');
  res.status(201).json({ id: Number(result.lastInsertRowid), name, color: color || '#999999' });
});

router.get('/:id', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
  conversation.tags = await tagsForConversationStmt.all(req.params.id);
  conversation.notes = await notesForConversationStmt.all(req.params.id);
  await clearUnreadStmt.run(req.params.id);
  res.json(conversation);
});

router.patch('/:id', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { status } = req.body || {};
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${VALID_STATUSES.join(', ')}` });
  }
  await updateStatusStmt.run(status, req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/assign', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const rawUserId = req.body ? req.body.user_id : undefined;
  const userId = rawUserId === null || rawUserId === undefined ? null : Number(rawUserId);

  if (req.user.role !== 'admin') {
    if (conversation.assigned_user_id !== null) {
      return res.status(403).json({ error: 'Conversa já está atribuída.' });
    }
    if (userId !== req.user.id) {
      return res.status(403).json({ error: 'Você só pode assumir conversas para si mesmo.' });
    }
  }

  if (userId !== null) {
    const target = await getActiveUserStmt.get(userId);
    if (!target) return res.status(400).json({ error: 'Usuário inválido ou inativo.' });
  }

  await assignStmt.run(userId, req.params.id);
  await broadcast('conversation_updated', { conversation_id: Number(req.params.id) });
  res.json({ ok: true });
});

router.post('/:id/tags', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { tag_id } = req.body || {};
  if (!tag_id) return res.status(400).json({ error: 'tag_id é obrigatório.' });
  await linkTagStmt.run(req.params.id, tag_id);
  res.json({ ok: true });
});

router.delete('/:id/tags/:tagId', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  await unlinkTagStmt.run(req.params.id, req.params.tagId);
  res.json({ ok: true });
});

router.post('/:id/notes', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body é obrigatório.' });
  const result = await insertNoteStmt.run(req.params.id, body);
  res.status(201).json({ id: Number(result.lastInsertRowid), body });
});

module.exports = router;
