const db = require('../db');

const getStmt = db.prepare(`
  SELECT
    c.id, c.platform, c.status, c.unread_count, c.last_message_at, c.window_expires_at,
    c.assigned_user_id, u.name AS assigned_user_name, u.color AS assigned_user_color,
    ct.id AS contact_id, ct.display_name, ct.phone, ct.profile_pic_url, ct.platform_user_id
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assigned_user_id
  WHERE c.id = ?
`);

function canAccess(conversation, user) {
  if (!conversation) return false;
  if (user.role === 'admin') return true;
  return conversation.assigned_user_id === null || conversation.assigned_user_id === user.id;
}

/** Retorna a conversa se existir E o usuário puder vê-la, senão null. */
async function loadVisibleConversation(id, user) {
  const conversation = await getStmt.get(id);
  return canAccess(conversation, user) ? conversation : null;
}

module.exports = { loadVisibleConversation, canAccess };
