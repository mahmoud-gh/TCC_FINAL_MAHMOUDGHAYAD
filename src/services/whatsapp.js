const logger = require('../utils/logger');

// ===========================================================================
//  WhatsApp Business Cloud API (oficial da Meta)
// ===========================================================================
//  Todos os envios do sistema (atendimento, chatbot, campanhas, opt-out)
//  passam por aqui. Recebimento e confirmações de entrega/leitura chegam
//  pelo webhook (src/routes/webhooks.js).
//
//  Sem WHATSAPP_ACCESS_TOKEN no .env o envio é apenas simulado (modo dev),
//  útil para testar o painel sem gastar mensagens.
// ===========================================================================

// A Meta desativa versões antigas da Graph API (a v20.0 expirou em 24/09/2026).
// A v25.0 é suportada até 07/2028. Para trocar, defina GRAPH_API_VERSION no .env.
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';

function apiUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

function temToken() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN);
}

async function graphFetch(path, options) {
  if (!temToken()) {
    logger.info('[modo dev — sem WHATSAPP_ACCESS_TOKEN] envio simulado:', options && options.body);
    return { messages: [{ id: `dev.simulado.${Date.now()}` }] };
  }

  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }
  return res.json();
}

function enviar(payload) {
  return graphFetch(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
}

// Texto livre: só é aceito pela Meta dentro da janela de 24 h desde a última
// mensagem do cliente. Fora dela, apenas modelos (templates) aprovados.
async function sendWhatsAppText(toPhone, body) {
  return enviar({ to: toPhone, type: 'text', text: { body } });
}

// Modelo aprovado pela Meta — usado pelas campanhas (comunicação proativa).
async function sendWhatsAppTemplate(toPhone, templateName, languageCode = 'pt_BR', components = []) {
  return enviar({
    to: toPhone,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

// Até 3 botões de resposta rápida (título com no máximo 20 caracteres).
async function sendWhatsAppButtons(toPhone, bodyText, buttons) {
  return enviar({
    to: toPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: String(b.label).slice(0, 20) },
        })),
      },
    },
  });
}

// Lista com até 10 opções (título com no máximo 24 caracteres).
async function sendWhatsAppList(toPhone, bodyText, buttonLabel, rows) {
  return enviar({
    to: toPhone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: String(buttonLabel).slice(0, 20),
        sections: [
          {
            title: 'Opções',
            rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: String(r.label).slice(0, 24) })),
          },
        ],
      },
    },
  });
}

// ------------------------------------------------------------------ mídia --
// O webhook traz só o id da mídia. O link que a Meta devolve expira em
// poucos minutos e exige o token, por isso o painel abre a mídia pela rota
// /api/midia/:id, que baixa o arquivo na hora (ver src/routes/media.js).
async function fetchMediaUrl(mediaId) {
  const data = await graphFetch(mediaId, { method: 'GET' });
  return data.url;
}

async function baixarMidia(mediaId) {
  if (!temToken()) throw new Error('WHATSAPP_ACCESS_TOKEN não configurado.');
  const info = await graphFetch(mediaId, { method: 'GET' });
  const res = await fetch(info.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Download da mídia ${res.status}`);
  return {
    conteudo: Buffer.from(await res.arrayBuffer()),
    tipo: info.mime_type || res.headers.get('content-type') || 'application/octet-stream',
  };
}

// ---------------------------------------------------------------- modelos --
// Modelos cadastrados na conta do WhatsApp Business (WABA), com a situação
// de aprovação. Usado para atualizar a situação dos modelos do painel.
async function listarModelosMeta() {
  if (!temToken()) throw new Error('WHATSAPP_ACCESS_TOKEN não configurado.');
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID não configurado.');

  const modelos = [];
  let caminho = `${waba}/message_templates?fields=name,status,language,category&limit=100`;
  for (let pagina = 0; caminho && pagina < 20; pagina += 1) {
    const data = await graphFetch(caminho, { method: 'GET' });
    modelos.push(...(data.data || []));
    const proxima = data.paging && data.paging.next;
    caminho = proxima ? proxima.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
  }
  return modelos;
}

module.exports = {
  GRAPH_VERSION,
  sendWhatsAppText,
  sendWhatsAppTemplate,
  sendWhatsAppButtons,
  sendWhatsAppList,
  fetchMediaUrl,
  baixarMidia,
  listarModelosMeta,
};
