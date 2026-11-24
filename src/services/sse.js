const db = require('../db');

const clients = new Set();

const getAssignedUserStmt = db.prepare('SELECT assigned_user_id FROM conversations WHERE id = ?');

function addClient(res, user) {
  clients.add({ res, user });
}

function removeClient(res) {
  for (const client of clients) {
    if (client.res === res) clients.delete(client);
  }
}

async function visibleTo(conversationId, user) {
  if (user.role === 'admin' || conversationId == null) return true;
  const row = await getAssignedUserStmt.get(conversationId);
  return !row || row.assigned_user_id === null || row.assigned_user_id === user.id;
}

async function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res, user } of clients) {
    if (await visibleTo(data.conversation_id, user)) {
      res.write(payload);
    }
  }
}

module.exports = { addClient, removeClient, broadcast };
