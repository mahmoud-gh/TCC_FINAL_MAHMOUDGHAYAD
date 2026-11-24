require('dotenv').config();

// ===========================================================================
//  TESTE DO CHATBOT — simula mensagens de WhatsApp chegando pelo webhook
// ===========================================================================
//  Nada é enviado à Meta nem à API de IA: o envio é interceptado e a IA é
//  simulada. Os dados de teste (contato, conversa, produtos) usam o prefixo
//  "chatbot-teste" / "ZZQTESTE" e são apagados no final.
//
//  Uso:  node scripts/testar-chatbot.js
// ===========================================================================

const crypto = require('node:crypto');

// ---- intercepta o envio ANTES de carregar o resto -----------------------
const whatsapp = require('../src/services/whatsapp');
const ENVIADAS = [];
const fakeId = () => `wamid.TESTE${crypto.randomBytes(5).toString('hex')}`;
whatsapp.sendWhatsAppText = async (to, body) => { ENVIADAS.push({ to, body }); return { messages: [{ id: fakeId() }] }; };
whatsapp.sendWhatsAppButtons = async (to, body, botoes) => {
  ENVIADAS.push({ to, body, botoes: botoes.map((b) => b.label) });
  return { messages: [{ id: fakeId() }] };
};

process.env.META_APP_SECRET = 'segredo-de-teste';
process.env.CHATBOT_ENABLED = 'true';
process.env.CHATBOT_IA = 'false';
process.env.CHATBOT_AGRUPAR_MS = '0'; // sem espera de rajada no teste
process.env.STORE_NAME = process.env.STORE_NAME || 'Loja Teste';
const HORARIO_ORIGINAL = {
  BUSINESS_DAYS: process.env.BUSINESS_DAYS, BUSINESS_HOURS_START: process.env.BUSINESS_HOURS_START,
  BUSINESS_HOURS_END: process.env.BUSINESS_HOURS_END,
};
const lojaFechada = () => { process.env.BUSINESS_DAYS = '1,2,3,4,5,6,7'; process.env.BUSINESS_HOURS_START = '00:00'; process.env.BUSINESS_HOURS_END = '00:00'; };
const lojaAberta = () => { process.env.BUSINESS_DAYS = '1,2,3,4,5,6,7'; process.env.BUSINESS_HOURS_START = '00:00'; process.env.BUSINESS_HOURS_END = '23:59'; };

const express = require('express');
const db = require('../src/db');
const webhooks = require('../src/routes/webhooks');
const chatbot = require('../src/services/chatbot');

const TEL = '5500999000123';
const TEL2 = '5500999000124';
const PRODUTOS = [
  [-990001, 'ZZQ-1', 'ZZQTESTE Lente Sony E 17-70mm F2.8', 540, 500, 7, 'Lentes', 'Tamron'],
  [-990002, 'ZZQ-2', 'ZZQTESTE Canon PowerShot G7X Mark III', 1229, 1180, 2, 'Câmeras', 'Canon'],
  [-990003, 'ZZQ-3', 'ZZQTESTE DJI Osmo Pocket 3', 789, 760, 0, 'Câmeras', 'DJI'],
];

let falhas = 0;
const ok = (cond, txt, extra = '') => {
  if (!cond) falhas += 1;
  console.log(`  [${cond ? 'OK   ' : 'FALHA'}] ${txt}${!cond && extra ? `\n          → ${extra}` : ''}`);
};

// ------------------------------------------------------------- servidor ----
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/webhooks/meta', webhooks);
let URL_BASE;

let seq = 0;
function payload(tel, mensagem) {
  seq += 1;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: tel, profile: { name: 'Lucas Teste' } }],
      messages: [{ from: tel, id: `wamid.IN${Date.now()}${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...mensagem }],
    } }] }],
  };
}
const texto = (t) => ({ type: 'text', text: { body: t } });
const botao = (id, titulo) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: titulo } } });
const audio = () => ({ type: 'audio', audio: { id: 'midia-teste' } });

async function chega(tel, mensagem) {
  const corpo = JSON.stringify(payload(tel, mensagem));
  const assinatura = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(corpo).digest('hex')}`;
  const antes = ENVIADAS.length;
  const r = await fetch(`${URL_BASE}/webhooks/meta`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': assinatura }, body: corpo,
  });
  if (r.status !== 200) throw new Error(`webhook respondeu ${r.status}`);
  // O processamento segue depois do 200. Espera a resposta chegar (até 8 s,
  // a IA ou a rede podem demorar) e mais 0,6 s para ver se vem outra.
  const inicio = Date.now();
  let ultimaMudanca = null;
  let visto = antes;
  while (Date.now() - inicio < 8000) {
    await new Promise((res) => setTimeout(res, 100));
    if (ENVIADAS.length !== visto) { visto = ENVIADAS.length; ultimaMudanca = Date.now(); }
    if (ultimaMudanca && Date.now() - ultimaMudanca > 600) break;
  }
  return ENVIADAS.slice(antes);
}

const ultimaInteracao = async (tel) => (await db.prepare(`
  SELECT ci.tipo, ci.produtos_encontrados FROM chatbot_interacoes ci
  JOIN conversations c ON c.id = ci.conversation_id JOIN contacts ct ON ct.id = c.contact_id
  WHERE ct.platform_user_id = ? ORDER BY ci.id DESC LIMIT 1`).get(tel)) || {};

// ------------------------------------------------------------- limpeza -----
async function limpar() {
  const conversas = `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.platform_user_id IN ('${TEL}','${TEL2}')`;
  const contatos = `SELECT id FROM contacts WHERE platform_user_id IN ('${TEL}','${TEL2}')`;
  await chatbot.garantirEsquema();
  await db.exec(`
    DELETE FROM chatbot_interacoes WHERE conversation_id IN (${conversas});
    DELETE FROM eventos_interacao WHERE contact_id IN (${contatos});
    DELETE FROM flow_run_events WHERE flow_run_id IN (SELECT id FROM flow_runs WHERE conversation_id IN (${conversas}));
    DELETE FROM flow_runs WHERE conversation_id IN (${conversas});
    DELETE FROM messages WHERE conversation_id IN (${conversas});
    DELETE FROM conversations WHERE id IN (${conversas});
    ALTER TABLE consentimentos DISABLE TRIGGER trg_consentimentos_imutavel;
    DELETE FROM consentimentos WHERE contact_id IN (${contatos});
    ALTER TABLE consentimentos ENABLE TRIGGER trg_consentimentos_imutavel;
    DELETE FROM contacts WHERE platform_user_id IN ('${TEL}','${TEL2}');
    DELETE FROM products WHERE id BETWEEN -990099 AND -990001;
  `);
}

// --------------------------------------------------------------- testes ----
async function testes() {
  for (const p of PRODUTOS) {
    await db.prepare(`INSERT INTO products (id, codigo, name, price, wholesale_price, stock, category_name, brand_name, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(...p);
  }

  console.log('\n Loja fechada');
  lojaFechada();

  let r = await chega(TEL, texto('Oi, boa noite'));
  ok(r.length === 1 && /fechada/.test(r[0].body) && r[0].botoes && r[0].botoes.length === 2,
    'Cumprimento → boas-vindas com os dois botões', JSON.stringify(r));

  r = await chega(TEL, botao(chatbot.BOTAO_ESTOQUE, 'Consultar estoque'));
  ok(r.length === 1 && /nome|marca|modelo/i.test(r[0].body), 'Botão "Consultar estoque" → pede o produto', JSON.stringify(r));

  r = await chega(TEL, texto('tem a zzqteste sony 17-70?'));
  ok(r.length === 1 && /17-70/.test(r[0].body) && /estoque|disponível/.test(r[0].body), 'Produto existente → nome, preço e estoque', JSON.stringify(r));
  ok(!/reserv/i.test(r[0] ? r[0].body : ''), 'Resposta não promete reserva');

  r = await chega(TEL, texto('e a zzqteste pocket 3?'));
  ok(r.length === 1 && /esgotado/.test(r[0].body), 'Estoque zero → informa esgotado', JSON.stringify(r));

  r = await chega(TEL, texto('zzqteste mavic 9 ultra pro'));
  ok(r.length === 1 && /Não encontrei/.test(r[0].body) && r[0].botoes, 'Produto inexistente → avisa e oferece atendente', JSON.stringify(r));
  ok((await ultimaInteracao(TEL)).tipo === 'sem_resultado', 'Consulta sem resultado registrada para métrica');

  r = await chega(TEL, texto('Que horas a loja fecha ?'));
  ok(r.length === 1 && /Funcionamos/.test(r[0].body) && !/Encontrei/.test(r[0].body),
    'Pergunta de horário → horário da loja (não lista produtos)', JSON.stringify(r));

  r = await chega(TEL, audio());
  ok(r.length === 1 && /áudio/.test(r[0].body), 'Áudio → pede para escrever', JSON.stringify(r));

  r = await chega(TEL, texto('quero falar com um atendente'));
  ok(r.length === 1 && /Anotado/.test(r[0].body), 'Pedido de atendente → recado anotado', JSON.stringify(r));

  r = await chega(TEL, texto('tem zzqteste g7x?'));
  ok(r.length === 0, 'Depois de pedir atendente, o bot fica em silêncio até a loja abrir', JSON.stringify(r));

  console.log('\n Precedência e limites');
  r = await chega(TEL2, texto('SAIR'));
  ok(r.length === 1 && /removido/.test(r[0].body), 'Palavra de saída → só a confirmação do opt-out, sem chatbot', JSON.stringify(r));
  const opt = await db.prepare(`SELECT k.tipo FROM consentimentos k JOIN contacts c ON c.id = k.contact_id
    WHERE c.platform_user_id = ? ORDER BY k.id DESC LIMIT 1`).get(TEL2);
  ok(opt && opt.tipo === 'opt_out', 'Opt-out gravado no histórico de consentimento');

  const conv2 = await db.prepare(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE ct.platform_user_id = ?`).get(TEL2);
  await db.prepare(`INSERT INTO messages (conversation_id, direction, message_type, content, status, origin)
    VALUES (?, 'out', 'text', 'Oi, aqui é o atendente', 'sent', 'human')`).run(conv2.id);
  r = await chega(TEL2, texto('tem zzqteste g7x?'));
  ok(r.length === 0, 'Atendente humano respondeu há pouco → bot não interfere', JSON.stringify(r));

  console.log('\n Loja aberta');
  lojaAberta();
  await db.prepare("DELETE FROM messages WHERE conversation_id = ? AND origin = 'human'").run(conv2.id);
  r = await chega(TEL2, texto('tem zzqteste g7x?'));
  ok(r.length === 0, 'Com a loja aberta, quem responde é o humano', JSON.stringify(r));

  console.log('\n IA (simulada, sem custo)');
  lojaFechada();
  await db.prepare("UPDATE conversations SET bot_pausado_ate = NULL WHERE id = ?").run(conv2.id);
  process.env.CHATBOT_IA = 'true';
  process.env.ANTHROPIC_API_KEY = 'chave-falsa-para-teste';
  const fetchOriginal = global.fetch;
  const pedidosIa = [];
  global.fetch = async (url, opcoes) => {
    if (!String(url).includes('api.anthropic.com')) return fetchOriginal(url, opcoes);
    const corpo = JSON.parse(opcoes.body);
    pedidosIa.push(corpo);
    const ultima = corpo.messages[corpo.messages.length - 1];
    const json = Array.isArray(ultima.content) && ultima.content[0].type === 'tool_result'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: `Temos sim: ${JSON.parse(ultima.content[0].content)[0].nome}.` }] }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'consultar_estoque', input: { termos: 'zzqteste g7x' } }] };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  r = await chega(TEL2, texto('vocês têm a zzqteste g7x?'));
  const segundo = pedidosIa[1];
  const resultado = segundo && segundo.messages[segundo.messages.length - 1].content[0];
  ok(pedidosIa.length === 2 && resultado && resultado.type === 'tool_result' && typeof resultado.content === 'string',
    'IA chama a ferramenta e recebe o resultado do catálogo (não uma Promise)', JSON.stringify(pedidosIa.map((p) => p.messages.length)));
  ok(r.some((m) => /G7X/.test(m.body)), 'Resposta da IA usa o produto achado no catálogo', JSON.stringify(r));
  ok(segundo && !/wholesale|preco_atacado/.test(JSON.stringify(segundo)), 'A IA só recebe os campos permitidos (sem preço de atacado no modo varejo)');

  global.fetch = async (url, opcoes) => {
    if (String(url).includes('api.anthropic.com')) return new Response('erro', { status: 500 });
    return fetchOriginal(url, opcoes);
  };
  r = await chega(TEL2, texto('tem zzqteste g7x?'));
  ok(r.length === 1 && /G7X/.test(r[0].body), 'IA fora do ar → resposta direta do catálogo', JSON.stringify(r));
  global.fetch = fetchOriginal;
}

// ------------------------------------------------------------ principal ----
(async () => {
  const servidor = app.listen(0);
  URL_BASE = `http://127.0.0.1:${servidor.address().port}`;
  console.log('Teste do chatbot — nada é enviado à Meta nem à API de IA.');
  try {
    await limpar();
    await testes();
  } catch (err) {
    falhas += 1;
    console.error('Erro no teste:', err.stack || err.message);
  } finally {
    Object.assign(process.env, HORARIO_ORIGINAL);
    try { await limpar(); } catch (e) { console.error('Falha na limpeza:', e.message); }
    servidor.close();
    await db.close();
  }
  console.log(`\n${falhas === 0 ? 'Tudo certo.' : `${falhas} verificação(ões) falharam.`}`);
  process.exit(falhas ? 1 : 0);
})();
