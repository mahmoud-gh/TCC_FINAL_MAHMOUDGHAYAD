const logger = require('../utils/logger');

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';

async function graphSend(body) {
  if (!process.env.INSTAGRAM_PAGE_ACCESS_TOKEN) {
    logger.info('[modo dev — sem INSTAGRAM_PAGE_ACCESS_TOKEN] envio simulado:', JSON.stringify(body));
    return { message_id: `dev.simulado.${Date.now()}` };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.INSTAGRAM_PAGE_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.INSTAGRAM_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Graph API ${res.status}: ${errBody}`);
  }
  return res.json();
}

async function sendInstagramText(recipientPsid, text) {
  return await graphSend({ recipient: { id: recipientPsid }, message: { text } });
}

async function sendInstagramQuickReplies(recipientPsid, text, options) {
  return await graphSend({
    recipient: { id: recipientPsid },
    message: {
      text,
      quick_replies: options.slice(0, 13).map((o) => ({
        content_type: 'text',
        title: o.label.slice(0, 20),
        payload: o.id,
      })),
    },
  });
}

module.exports = { sendInstagramText, sendInstagramQuickReplies };
