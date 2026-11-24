const express = require('express');
const db = require('../db');
const { sendWhatsAppText } = require('../services/whatsapp');
const { sendInstagramText } = require('../services/instagram');
const { broadcast } = require('../services/sse');
const { loadVisibleConversation } = require('../services/conversationAccess');
const campaignEngine = require('../services/campaignEngine'); // [NOVO]
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

const listMessagesStmt = db.prepare(`
  SELECT id, direction, message_type, content, media_url, status, origin, created_at
  FROM messages
  WHERE conversation_id = ?
  ORDER BY created_at ASC
`);

// [ALTERADO] grava também o platform_message_id: sem o identificador retornado
// pela Cloud API nenhum evento de webhook (entrega/leitura) pode ser vinculado
// à mensagem enviada — RF08/RF09.
const insertMessageStmt = db.prepare(`
  INSERT INTO messages (conversation_id, direction, message_type, content, status, origin, platform_message_id)
  VALUES (?, 'out', 'text', ?, 'sent', 'human', ?)
`);

const touchConversationStmt = db.prepare(`
  UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = ?
`);

router.get('/', async (req, res) => {
  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json(await listMessagesStmt.all(req.params.id));
});

router.post('/', async (req, res) => {
  const { text, campanha_id } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text é obrigatório.' });

  const conversation = await loadVisibleConversation(req.params.id, req.user);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

  let platformMessageId = null;
  try {
    if (conversation.platform === 'whatsapp') {
      // [ALTERADO] captura a resposta da Graph API
      const resposta = await sendWhatsAppText(conversation.phone, text);
      platformMessageId =
        (resposta && resposta.messages && resposta.messages[0] && resposta.messages[0].id) || null;
    } else {
      const resposta = await sendInstagramText(conversation.platform_user_id, text);
      platformMessageId = (resposta && resposta.message_id) || null;
    }
  } catch (err) {
    return res.status(502).json({ error: `Falha ao enviar via ${conversation.platform}: ${err.message}` });
  }

  const result = await insertMessageStmt.run(conversation.id, text, platformMessageId);
  await touchConversationStmt.run(conversation.id);

  // [NOVO] Cenário manual da prova de conceito: quando o operador envia a
  // campanha à mão pelo inbox, o envio é registrado na campanha correspondente
  // (com a mesma verificação de consentimento), permitindo a comparação
  // pré-teste/pós-teste prevista na Seção 3.5.
  let envioId = null;
  if (campanha_id) {
    try {
      const registro = await campaignEngine.registrarEnvioManual({
        campanhaId: Number(campanha_id),
        contactId: conversation.contact_id,
        conteudo: text,
        idApi: platformMessageId,
        messageId: Number(result.lastInsertRowid),
      });
      envioId = registro.envioId;
    } catch (err) {
      logger.error('Falha ao vincular envio manual à campanha:', err.message);
    }
  }

  const message = {
    id: Number(result.lastInsertRowid),
    conversation_id: conversation.id,
    direction: 'out',
    message_type: 'text',
    content: text,
    status: 'sent',
    origin: 'human',
    envio_id: envioId,
  };
  await broadcast('message', message);

  res.status(201).json(message);
});

module.exports = router;
