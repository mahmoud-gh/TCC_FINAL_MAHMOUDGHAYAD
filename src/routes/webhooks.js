const express = require('express');
const db = require('../db');
const verifySignature = require('../services/verifySignature');
const { parseWebhookBody } = require('../services/metaWebhookParser');
const { broadcast } = require('../services/sse');
const flowEngine = require('../services/flowEngine');
const aiAgent = require('../services/aiAgent');
const chatbot = require('../services/chatbot'); // atendimento fora do expediente (WhatsApp)
const campaignEngine = require('../services/campaignEngine'); // [NOVO] RF09
const logger = require('../utils/logger');

const router = express.Router();

const findContactStmt = db.prepare(
  'SELECT id, display_name FROM contacts WHERE platform = ? AND platform_user_id = ?'
);
const insertContactStmt = db.prepare(
  'INSERT INTO contacts (platform, platform_user_id, display_name, phone) VALUES (?, ?, ?, ?)'
);
const updateContactNameStmt = db.prepare(
  "UPDATE contacts SET display_name = ? WHERE id = ? AND (display_name IS NULL OR display_name = '')"
);
const findConversationStmt = db.prepare('SELECT id FROM conversations WHERE contact_id = ?');
const insertConversationStmt = db.prepare(`
  INSERT INTO conversations (contact_id, platform, status, unread_count, last_message_at, window_expires_at)
  VALUES (?, ?, 'novo', 0, now(), (now() + interval '24 hours'))
`);
const touchConversationInboundStmt = db.prepare(`
  UPDATE conversations
  SET last_message_at = now(),
      unread_count = unread_count + 1,
      window_expires_at = CASE WHEN platform = 'whatsapp' THEN (now() + interval '24 hours') ELSE window_expires_at END,
      updated_at = now()
  WHERE id = ?
`);
const insertMessageStmt = db.prepare(`
  INSERT INTO messages (conversation_id, direction, platform_message_id, message_type, content, media_url, status, raw_payload)
  VALUES (?, 'in', ?, ?, ?, ?, 'received', ?)
`);
const updateMessageStatusStmt = db.prepare(
  'UPDATE messages SET status = ? WHERE platform_message_id = ?'
);

// [NOVO] RF01 — `ultima_interacao` alimenta as regras de segmentação
// (ex.: "sem interação há N dias", "interação nos últimos 15 dias").
const touchContactInteractionStmt = db.prepare(
  "UPDATE contacts SET ultima_interacao = now(), updated_at = now() WHERE id = ?"
);
// [NOVO] contato completo para o motor de campanhas (telefone, opt-out etc.)
const getContactStmt = db.prepare('SELECT * FROM contacts WHERE id = ?');

async function getOrCreateConversation(contactId, platform) {
  const existing = await findConversationStmt.get(contactId);
  if (existing) return { id: existing.id, isNew: false };
  const result = await insertConversationStmt.run(contactId, platform);
  return { id: Number(result.lastInsertRowid), isNew: true };
}

// Mesma mensagem não é processada duas vezes: a Meta reentrega webhooks
// quando não recebe o 200 a tempo. Sem isso, o cliente recebia duas
// respostas iguais do chatbot.
const emProcessamento = new Set();
const jaRecebidaStmt = db.prepare(
  "SELECT 1 FROM messages WHERE platform_message_id = ? AND direction = 'in' LIMIT 1"
);

// Avisos internos do WhatsApp (criptografia, mensagem apagada...) e textos
// só com caracteres invisíveis: não viram balão vazio no inbox nem acionam
// o chatbot. Mídia, botões e os demais tipos seguem normalmente.
const AVISOS_INTERNOS = new Set(['e2e_notification', 'notification_template', 'notification', 'ciphertext',
  'protocol', 'revoked', 'gp2', 'call_log', 'unknown', 'debug']);
const INVISIVEIS = /[\s\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
function semConteudo(msg) {
  if (msg.mediaId || msg.mediaUrl || msg.interactiveId) return false;
  if (String(msg.text || '').replace(INVISIVEIS, '').length) return false;
  return msg.messageType === 'text' || AVISOS_INTERNOS.has(msg.messageType);
}

const filasContato = new Map(); // "plataforma|contato" -> Promise da última gravação
function filaDoContato(chave, tarefa) {
  const anterior = filasContato.get(chave) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  filasContato.set(chave, atual);
  atual.finally(() => { if (filasContato.get(chave) === atual) filasContato.delete(chave); }).catch(() => {});
  return atual;
}

async function handleIncomingMessage(msg) {
  if (semConteudo(msg)) {
    logger.info(`Mensagem sem conteúdo ignorada (tipo "${msg.messageType}") de ${msg.platformUserId}`);
    return;
  }
  const idMsg = msg.platformMessageId;
  if (idMsg) {
    // Marca ANTES de qualquer await: duas entregas da mesma mensagem chegando
    // juntas passavam as duas pela consulta ao banco e eram gravadas em dobro.
    if (emProcessamento.has(idMsg)) return;
    emProcessamento.add(idMsg);
  }
  try {
    if (idMsg && await jaRecebidaStmt.get(idMsg)) return;
    // Mensagens do mesmo contato são gravadas uma de cada vez: com várias
    // chegando juntas de um contato novo, o contato (e a conversa) eram
    // criados em dobro e uma das mensagens se perdia. O chatbot roda depois,
    // fora da fila, para poder juntar mensagens em rajada.
    const depois = await filaDoContato(`${msg.platform}|${msg.platformUserId}`, () => processarMensagemRecebida(msg));
    if (typeof depois === 'function') await depois();
  } finally {
    if (idMsg) setTimeout(() => emProcessamento.delete(idMsg), 60000);
  }
}

async function processarMensagemRecebida(msg) {
  let contact = await findContactStmt.get(msg.platform, msg.platformUserId);
  let contactId;
  if (contact) {
    contactId = contact.id;
    if (msg.displayName) await updateContactNameStmt.run(msg.displayName, contactId);
  } else {
    const result = await insertContactStmt.run(msg.platform, msg.platformUserId, msg.displayName || null, msg.phone || null);
    contactId = Number(result.lastInsertRowid);
  }

  const { id: conversationId, isNew: isNewConversation } = await getOrCreateConversation(contactId, msg.platform);

  // WhatsApp: o painel abre a mídia pela rota /api/midia/:id, que baixa o
  // arquivo da Meta com o token (o link direto da Meta expira em minutos).
  // Instagram: o webhook já traz o link público.
  let mediaUrl = msg.mediaUrl || null;
  if (msg.mediaId && !mediaUrl) mediaUrl = `/api/midia/${encodeURIComponent(msg.mediaId)}`;

  const result = await insertMessageStmt.run(
    conversationId,
    msg.platformMessageId || null,
    msg.messageType,
    msg.text,
    mediaUrl,
    JSON.stringify(msg)
  );

  await touchConversationInboundStmt.run(conversationId);
  await touchContactInteractionStmt.run(contactId); // [NOVO]

  await broadcast('message', {
    id: Number(result.lastInsertRowid),
    conversation_id: conversationId,
    direction: 'in',
    message_type: msg.messageType,
    content: msg.text,
    media_url: mediaUrl,
  });
  await broadcast('conversation_updated', { conversation_id: conversationId });

  // ---------------------------------------------------------------------
  // [NOVO] Marketing ativo (RF02, RF09)
  // 1) Revogação de consentimento por palavra-chave: registrada como nova
  //    manifestação (opt-out) e com efeito imediato sobre a elegibilidade.
  // 2) Resposta atribuída ao envio de campanha mais recente do contato,
  //    dentro da janela de atribuição — origem da taxa de resposta e do
  //    tempo médio de resposta.
  // ---------------------------------------------------------------------
  if (msg.platform === 'whatsapp') {
    const contatoCompleto = await getContactStmt.get(contactId);

    if (msg.text && campaignEngine.ehPedidoDeOptOut(msg.text)) {
      try {
        await campaignEngine.processarOptOut(contatoCompleto, msg.text);
        logger.info(`Opt-out registrado para o contato ${contactId}.`);
      } catch (err) {
        logger.error('Falha ao registrar opt-out:', err.message);
      }
      return; // não aciona fluxo nem IA numa solicitação de descadastro
    }

    try {
      await campaignEngine.registrarResposta(contactId, {
        message_id: msg.platformMessageId,
        tipo: msg.messageType,
      });
    } catch (err) {
      logger.error('Falha ao registrar resposta de campanha:', err.message);
    }
  }

  // Automação (Salesbot) e IA fora do horário: efeitos colaterais adicionais —
  // nunca substituem o registro acima no inbox.
  const activeRun = await flowEngine.getActiveFlowRun(conversationId);
  let flowHandled = false;
  if (activeRun) {
    if (activeRun.status === 'waiting_reply') {
      await flowEngine.handleReplyForFlow(activeRun, msg);
    }
    flowHandled = true; // fluxo ativo (running/waiting_reply/paused) — IA nunca interrompe
  } else if (isNewConversation) {
    flowHandled = await flowEngine.maybeStartFlow(conversationId);
  }

  if (!flowHandled) {
    // WhatsApp: chatbot de consulta de estoque com a loja fechada.
    // Instagram: mantém o agente anterior.
    // Devolvido para rodar fora da fila do contato (ver handleIncomingMessage).
    return () => (msg.platform === 'whatsapp'
      ? chatbot.maybeRespond(conversationId, msg)
      : aiAgent.maybeRespond(conversationId));
  }
  return null;
}

async function processWebhookBody(body) {
  const { messages, statuses } = parseWebhookBody(body);

  for (const msg of messages) {
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      logger.error('Erro processando mensagem recebida:', err);
    }
  }

  for (const status of statuses) {
    await processarStatus(status);
  }
}

// [NOVO] RF09 — cada notificação vira um EventoInteracao vinculado ao
// envio, à campanha e ao contato. O `id_evento_api` único absorve as
// reentregas da Meta sem duplicar a métrica.
async function processarStatus(status) {
  await updateMessageStatusStmt.run(status.status, status.platformMessageId);
  if (status.status === 'failed' && status.errors) {
    logger.error('Entrega recusada pela Meta:', JSON.stringify(status.errors));
  }
  try {
    await campaignEngine.registrarStatusWebhook(status);
  } catch (err) {
    logger.error('Falha ao registrar evento de campanha:', err.message);
  }
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', verifySignature, (req, res) => {
  res.sendStatus(200);
  processWebhookBody(req.body).catch((err) => logger.error('Erro no webhook:', err));
});

module.exports = router;
// Usados pelos scripts de teste.
module.exports.handleIncomingMessage = handleIncomingMessage;
module.exports.processarStatus = processarStatus;
