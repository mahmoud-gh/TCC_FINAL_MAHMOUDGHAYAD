const db = require('../db');
const { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList } = require('./whatsapp');
const { sendInstagramText, sendInstagramQuickReplies } = require('./instagram');
const { broadcast } = require('./sse');
const logger = require('../utils/logger');

const NO_MATCH_OUTPUT = 'output_1';
const NO_REPLY_OUTPUT = 'output_2';
const SEND_FAILED_OUTPUT = 'output_3';
const TEXT_ONLY_SUCCESS_OUTPUT = 'output_1';
const TEXT_ONLY_FAILED_OUTPUT = 'output_2';

const activeFlowStmt = db.prepare(
  "SELECT * FROM flows WHERE is_active = 1 AND trigger_type = 'first_message' LIMIT 1"
);
const flowByIdStmt = db.prepare('SELECT * FROM flows WHERE id = ?');
const activeRunStmt = db.prepare(
  "SELECT * FROM flow_runs WHERE conversation_id = ? AND status IN ('running','waiting_reply','paused')"
);
const insertRunStmt = db.prepare(
  "INSERT INTO flow_runs (flow_id, conversation_id, current_node_id, status) VALUES (?, ?, ?, 'running')"
);
const updateRunStmt = db.prepare(`
  UPDATE flow_runs SET current_node_id = ?, status = ?, resume_at = ?, updated_at = now() WHERE id = ?
`);
const completeRunStmt = db.prepare(`
  UPDATE flow_runs SET status = 'completed', resume_at = NULL, updated_at = now() WHERE id = ?
`);
const insertEventStmt = db.prepare(`
  INSERT INTO flow_run_events (flow_run_id, node_id, node_type, event, branch_output) VALUES (?, ?, ?, ?, ?)
`);
const conversationContactStmt = db.prepare(`
  SELECT c.id, c.platform, ct.phone, ct.platform_user_id
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
  WHERE c.id = ?
`);
const insertOutMessageStmt = db.prepare(`
  INSERT INTO messages (conversation_id, direction, message_type, content, status, raw_payload, origin)
  VALUES (?, 'out', ?, ?, 'sent', ?, 'bot')
`);
const touchConversationStmt = db.prepare(
  "UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = ?"
);
const linkTagStmt = db.prepare(
  'INSERT INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
);
const updateConversationStatusStmt = db.prepare(
  "UPDATE conversations SET status = ?, updated_at = now() WHERE id = ?"
);
const assignIfUnclaimedStmt = db.prepare(
  "UPDATE conversations SET assigned_user_id = ?, updated_at = now() WHERE id = ? AND assigned_user_id IS NULL"
);
const getActiveUserStmt = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1');
const dueRunsStmt = db.prepare(`
  SELECT * FROM flow_runs
  WHERE status IN ('paused','waiting_reply') AND resume_at IS NOT NULL AND resume_at <= now()
`);

function timestampUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function inSeconds(seconds) {
  return timestampUtc(new Date(Date.now() + seconds * 1000));
}

function parseGraph(flow) {
  return JSON.parse(flow.graph_json);
}

function graphNodes(graph) {
  return (graph.drawflow && graph.drawflow.Home && graph.drawflow.Home.data) || {};
}

function getNode(graph, nodeId) {
  return graphNodes(graph)[String(nodeId)];
}

function findTriggerNode(graph) {
  return Object.values(graphNodes(graph)).find((n) => n.name === 'trigger');
}

function resolveNext(node, outputKey) {
  const output = node.outputs && node.outputs[outputKey];
  const conn = output && output.connections && output.connections[0];
  return conn ? String(conn.node) : null;
}

async function logEvent(runId, nodeId, nodeType, event, branchOutput) {
  await insertEventStmt.run(runId, String(nodeId), nodeType, event, branchOutput || null);
}

async function completeRun(runId) {
  await completeRunStmt.run(runId);
}

function normalizeText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchReply(node, msg) {
  const buttons = (node.data && node.data.buttons) || [];

  if (msg.interactiveId) {
    const idx = buttons.findIndex((b) => b.id === msg.interactiveId);
    if (idx !== -1) return `output_${4 + idx}`;
  }

  const normalized = normalizeText(msg.text);
  if (normalized) {
    const candidatesFor = (b) => [b.label, ...(b.synonyms || [])].map(normalizeText);

    let idx = buttons.findIndex((b) => candidatesFor(b).includes(normalized));
    if (idx === -1) {
      idx = buttons.findIndex((b) => candidatesFor(b).some((c) => c && normalized.includes(c)));
    }
    if (idx !== -1) return `output_${4 + idx}`;
  }

  return NO_MATCH_OUTPUT;
}

async function getActiveFlowRun(conversationId) {
  return await activeRunStmt.get(conversationId);
}

async function maybeStartFlow(conversationId) {
  const flow = await activeFlowStmt.get();
  if (!flow) return false;

  const graph = parseGraph(flow);
  const trigger = findTriggerNode(graph);
  if (!trigger) return false;

  const nextNodeId = resolveNext(trigger, 'output_1');
  if (!nextNodeId) return false;

  const result = await insertRunStmt.run(flow.id, conversationId, String(trigger.id));
  const run = { id: Number(result.lastInsertRowid), flow_id: flow.id, conversation_id: conversationId };
  await logEvent(run.id, trigger.id, 'trigger', 'entered', null);

  await runNode(run, graph, nextNodeId);
  return true;
}

async function handleReplyForFlow(run, msg) {
  const flow = await flowByIdStmt.get(run.flow_id);
  if (!flow) return;
  const graph = parseGraph(flow);
  const node = getNode(graph, run.current_node_id);
  if (!node) {
    await completeRun(run.id);
    return;
  }

  const outputKey = matchReply(node, msg);
  await logEvent(run.id, run.current_node_id, node.name, 'branch_taken', outputKey);

  const nextNodeId = resolveNext(node, outputKey);
  if (!nextNodeId) {
    await completeRun(run.id);
    return;
  }
  await runNode(run, graph, nextNodeId);
}

async function runNode(run, graph, nodeId) {
  const node = getNode(graph, nodeId);
  if (!node) {
    await completeRun(run.id);
    return;
  }

  switch (node.name) {
    case 'send_message':
      return await executeSendMessage(run, graph, node);
    case 'pause':
      return await executePause(run, node);
    case 'create_lead':
      return await executeCreateLead(run, graph, node);
    case 'stop_bot':
      return await executeStopBot(run, node);
    default:
      await completeRun(run.id);
  }
}

async function executeSendMessage(run, graph, node) {
  const conv = await conversationContactStmt.get(run.conversation_id);
  if (!conv) {
    await completeRun(run.id);
    return;
  }

  const data = node.data || {};
  const kind = data.message_kind || 'text_only';
  const bodyText = data.body_text || '';
  const buttons = data.buttons || [];

  try {
    if (kind === 'text_only') {
      if (conv.platform === 'whatsapp') await sendWhatsAppText(conv.phone, bodyText);
      else await sendInstagramText(conv.platform_user_id, bodyText);
    } else if (kind === 'buttons') {
      if (conv.platform === 'whatsapp') await sendWhatsAppButtons(conv.phone, bodyText, buttons);
      else await sendInstagramQuickReplies(conv.platform_user_id, bodyText, buttons);
    } else if (kind === 'list') {
      if (conv.platform === 'whatsapp') {
        await sendWhatsAppList(conv.phone, bodyText, data.list_button_label || 'Escolher', buttons);
      } else {
        // Instagram não tem "lista" nativa — usa quick replies (limite 13) como equivalente.
        await sendInstagramQuickReplies(conv.platform_user_id, bodyText, buttons);
      }
    }
  } catch (err) {
    logger.error('flowEngine: falha ao enviar mensagem do fluxo:', err.message);
    await logEvent(run.id, node.id, 'send_message', 'send_failed', null);
    const failOutput = kind === 'text_only' ? TEXT_ONLY_FAILED_OUTPUT : SEND_FAILED_OUTPUT;
    const nextNodeId = resolveNext(node, failOutput);
    if (!nextNodeId) {
      await completeRun(run.id);
      return;
    }
    await runNode(run, graph, nextNodeId);
    return;
  }

  const messageType = kind === 'text_only' ? 'text' : `interactive_${kind}`;
  const insertResult = await insertOutMessageStmt.run(
    run.conversation_id,
    messageType,
    bodyText,
    JSON.stringify({ kind, buttons })
  );
  await touchConversationStmt.run(run.conversation_id);
  await broadcast('message', {
    id: Number(insertResult.lastInsertRowid),
    conversation_id: run.conversation_id,
    direction: 'out',
    message_type: messageType,
    content: bodyText,
    origin: 'bot',
  });
  await broadcast('conversation_updated', { conversation_id: run.conversation_id });

  await logEvent(run.id, node.id, 'send_message', 'entered', null);

  if (kind === 'text_only') {
    const nextNodeId = resolveNext(node, TEXT_ONLY_SUCCESS_OUTPUT);
    if (!nextNodeId) {
      await completeRun(run.id);
      return;
    }
    await runNode(run, graph, nextNodeId);
  } else {
    const timeoutMinutes = Number(data.no_reply_timeout_minutes) || 30;
    await updateRunStmt.run(String(node.id), 'waiting_reply', inSeconds(timeoutMinutes * 60), run.id);
  }
}

async function executePause(run, node) {
  await logEvent(run.id, node.id, 'pause', 'entered', null);
  const nextNodeId = resolveNext(node, 'output_1');
  if (!nextNodeId) {
    await completeRun(run.id);
    return;
  }
  const durationSeconds = Number(node.data && node.data.duration_seconds) || 0;
  await updateRunStmt.run(nextNodeId, 'paused', inSeconds(durationSeconds), run.id);
}

async function executeCreateLead(run, graph, node) {
  const data = node.data || {};
  const tagIds = data.tag_ids || [];

  db.exec('BEGIN');
  try {
    for (const tagId of tagIds) {
      await linkTagStmt.run(run.conversation_id, tagId);
    }
    if (data.set_status) {
      await updateConversationStatusStmt.run(data.set_status, run.conversation_id);
    }
    if (data.assigned_user_id && await getActiveUserStmt.get(data.assigned_user_id)) {
      await assignIfUnclaimedStmt.run(data.assigned_user_id, run.conversation_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  await logEvent(run.id, node.id, 'create_lead', 'entered', null);
  await broadcast('conversation_updated', { conversation_id: run.conversation_id });

  const nextNodeId = resolveNext(node, 'output_1');
  if (!nextNodeId) {
    await completeRun(run.id);
    return;
  }
  await runNode(run, graph, nextNodeId);
}

async function executeStopBot(run, node) {
  await logEvent(run.id, node.id, 'stop_bot', 'entered', null);
  await completeRun(run.id);
}

async function processDueRuns() {
  const due = await dueRunsStmt.all();
  for (const run of due) {
    try {
      const flow = await flowByIdStmt.get(run.flow_id);
      if (!flow) {
        await completeRun(run.id);
        continue;
      }
      const graph = parseGraph(flow);

      if (run.status === 'paused') {
        await runNode(run, graph, run.current_node_id);
      } else if (run.status === 'waiting_reply') {
        const node = getNode(graph, run.current_node_id);
        if (!node) {
          await completeRun(run.id);
          continue;
        }
        await logEvent(run.id, run.current_node_id, node.name, 'branch_taken', NO_REPLY_OUTPUT);
        const nextNodeId = resolveNext(node, NO_REPLY_OUTPUT);
        if (!nextNodeId) {
          await completeRun(run.id);
          continue;
        }
        await runNode(run, graph, nextNodeId);
      }
    } catch (err) {
      logger.error('flowEngine: erro processando flow_run vencido:', err);
    }
  }
}

module.exports = {
  getActiveFlowRun,
  maybeStartFlow,
  handleReplyForFlow,
  processDueRuns,
};
