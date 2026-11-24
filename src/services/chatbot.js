const db = require('../db');
const { isWithinBusinessHours, proximaAbertura, dataProximaAbertura, dataUltimoFechamento, descreverHorario } = require('./businessHours');
const { searchProducts } = require('./productCatalog');
const { sendWhatsAppText, sendWhatsAppButtons } = require('./whatsapp');
const { broadcast } = require('./sse');
const logger = require('../utils/logger');

// ===========================================================================
//  CHATBOT DE ATENDIMENTO FORA DO EXPEDIENTE — consulta de estoque e preço
// ===========================================================================
//
//  Só age com a loja FECHADA. Dentro do expediente quem responde é o humano.
//
//  Ordem das regras (a primeira que se aplica encerra o atendimento):
//    0. Palavra de saída ("sair", "parar"...) → tratada ANTES, no webhook
//       (opt-out da LGPD). O chatbot nunca responde a ela.
//    1. Chatbot desligado, loja aberta ou canal não suportado → silêncio.
//    2. Atendente humano respondeu nas últimas horas → silêncio.
//    3. Cliente já pediu atendente neste período fechado → silêncio.
//    4. Limite diário de respostas do bot por conversa → silêncio.
//    5. Pedido de atendente (botão ou texto) → recado anotado, bot pausa
//       até a loja abrir.
//    6. Áudio, imagem, vídeo, documento → pede para escrever.
//    7. Primeira mensagem no período fechado → boas-vindas com botões.
//    8. Botão "Consultar estoque" → pede o nome do produto.
//    9. Texto livre → consulta ao catálogo (IA com ferramenta de busca; sem
//       IA ou se ela falhar, busca direta no catálogo com resposta pronta).
//
//  A IA NÃO inventa preço nem estoque: a única fonte é a tabela `products`,
//  consultada pela ferramenta de busca. Também não fecha pedido, não reserva
//  e não combina pagamento — isso fica para o atendente.
//
//  Cada decisão é registrada em `chatbot_interacoes` (métricas do chatbot).
// ===========================================================================

const cfg = () => ({
  ativo: (process.env.CHATBOT_ENABLED || 'true') !== 'false',
  usarIa: Boolean(require('./anthropic').chave()) &&(process.env.CHATBOT_IA || 'true') !== 'false',
  modelo: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  loja: process.env.STORE_NAME || 'nossa loja',
  moeda: process.env.CHATBOT_MOEDA || 'USD',
  preco: process.env.CHATBOT_PRECO || 'varejo', // varejo | atacado | ambos | nenhum
  mostrarQuantidade: (process.env.CHATBOT_MOSTRAR_QUANTIDADE || 'true') !== 'false',
  pausaHumanoHoras: Number(process.env.CHATBOT_PAUSA_HUMANO_HORAS || 12),
  limiteDiario: Number(process.env.CHATBOT_LIMITE_DIARIO || 20),
});

const anthropic = require('./anthropic');
const { ANTHROPIC_API_URL } = anthropic;
const MAX_RODADAS_FERRAMENTA = 3;
const HISTORICO_HORAS = 6;
const HISTORICO_LIMITE = 12;

const BOTAO_ESTOQUE = 'bot_estoque';
const BOTAO_ATENDENTE = 'bot_atendente';

// ------------------------------------------------------------- esquema ----
let esquemaPronto = null;
function garantirEsquema() {
  if (!esquemaPronto) {
    esquemaPronto = db.exec(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_pausado_ate TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS chatbot_interacoes (
        id                  SERIAL PRIMARY KEY,
        conversation_id     INTEGER NOT NULL REFERENCES conversations(id),
        tipo                TEXT NOT NULL CHECK (tipo IN (
                              'boas_vindas','pedido_produto','consulta_ia','consulta_direta',
                              'sem_resultado','atendente','midia','erro_ia','horario')),
        entrada             TEXT,
        produtos_encontrados INTEGER,
        data_hora           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE chatbot_interacoes DROP CONSTRAINT IF EXISTS chatbot_interacoes_tipo_check;
      ALTER TABLE chatbot_interacoes ADD CONSTRAINT chatbot_interacoes_tipo_check CHECK (tipo IN (
        'boas_vindas','pedido_produto','consulta_ia','consulta_direta',
        'sem_resultado','atendente','midia','erro_ia','horario'));
      CREATE INDEX IF NOT EXISTS idx_chatbot_interacoes_conversa
        ON chatbot_interacoes(conversation_id, data_hora);
    `).catch((err) => { esquemaPronto = null; throw err; });
  }
  return esquemaPronto;
}

// ------------------------------------------------------------ consultas ----
const q = {
  conversa: db.prepare(`
    SELECT c.id, c.platform, c.bot_pausado_ate, ct.id AS contact_id, ct.phone,
           ct.platform_user_id, ct.display_name
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.id = ?`),
  humanoRecente: db.prepare(`
    SELECT 1 FROM messages
    WHERE conversation_id = ? AND direction = 'out' AND origin = 'human'
      AND created_at > now() - CAST(? AS INTEGER) * INTERVAL '1 hour'
    LIMIT 1`),
  botHoje: db.prepare(`
    SELECT COUNT(*)::int AS n FROM messages
    WHERE conversation_id = ? AND direction = 'out' AND origin IN ('bot','ai')
      AND created_at > now() - INTERVAL '1 day'`),
  boasVindasNoPeriodo: db.prepare(`
    SELECT 1 FROM chatbot_interacoes
    WHERE conversation_id = ? AND tipo = 'boas_vindas' AND data_hora > ?
    LIMIT 1`),
  historico: db.prepare(`
    SELECT direction, content FROM messages
    WHERE conversation_id = ? AND content IS NOT NULL AND content <> ''
      AND created_at > now() - CAST(? AS INTEGER) * INTERVAL '1 hour'
    ORDER BY created_at DESC, id DESC
    LIMIT ?`),
  pausar: db.prepare('UPDATE conversations SET bot_pausado_ate = ?, updated_at = now() WHERE id = ?'),
  inserirMensagem: db.prepare(`
    INSERT INTO messages (conversation_id, direction, platform_message_id, message_type, content, status, origin)
    VALUES (?, 'out', ?, ?, ?, 'sent', ?)`),
  tocarConversa: db.prepare('UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = ?'),
  registrar: db.prepare(`
    INSERT INTO chatbot_interacoes (conversation_id, tipo, entrada, produtos_encontrados)
    VALUES (?, ?, ?, ?)`),
};

// ------------------------------------------------------------ utilidades --
const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

const PEDE_ATENDENTE = /\b(atendente|humano|pessoa|vendedor|falar com (alguem|voce|voces)|atencion|asesor|vendedora)\b/;
const PERGUNTA_HORARIO = /\b(horario|horarios|que horas|abre|abrem|abri|fecha|fecham|funciona|funcionam|funcionamento|aberto|aberta|abiertos|cierran|abren)\b/;
const PEDE_CONSULTA = /^(consultar estoque|consultar|consulta|estoque|ver estoque|produtos?|catalogo|lista)$/;
// Mensagem só de cumprimento: todas as palavras são de saudação.
const PALAVRAS_SAUDACAO = new Set(('oi oii oiii ola ole opa eai e ai bom boa bons dia dias tarde tardes noite noites '
  + 'hola buenas buen buenos noches tudo td bem como vai amigo amiga irmao mano chefe menu inicio '
  + 'tranquilo blz beleza salve hello hi ok').split(' '));
const ehSaudacao = (norm) => Boolean(norm) && norm.split(' ').every((w) => PALAVRAS_SAUDACAO.has(w));
const MIDIA = ['image', 'audio', 'video', 'document', 'sticker'];

const primeiroNome = (nome) => (String(nome || '').trim().split(/\s+/)[0] || '');

function formatarPreco(valor) {
  if (valor == null || Number.isNaN(Number(valor))) return null;
  return `${cfg().moeda} ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function linhaPreco(p) {
  const { preco } = cfg();
  const v = formatarPreco(p.price);
  const a = formatarPreco(p.wholesale_price);
  if (preco === 'nenhum') return '';
  if (preco === 'atacado') return a ? ` — ${a}` : (v ? ` — ${v}` : '');
  if (preco === 'ambos') return [v && ` — ${v}`, a && ` (atacado ${a})`].filter(Boolean).join('');
  return v ? ` — ${v}` : '';
}

function linhaEstoque(stock) {
  const n = Number(stock || 0);
  if (n <= 0) return 'esgotado no momento';
  if (!cfg().mostrarQuantidade) return 'disponível';
  if (n <= 3) return `últimas ${n} unidade${n > 1 ? 's' : ''}`;
  return `em estoque (${n} un.)`;
}

// Produto como a IA e a resposta direta enxergam: só o que pode ser dito.
function produtoParaCliente(p) {
  const { preco } = cfg();
  const item = { codigo: p.codigo, nome: p.name, marca: p.brand_name };
  if (cfg().mostrarQuantidade) item.estoque = Number(p.stock || 0);
  else item.disponivel = Number(p.stock || 0) > 0;
  if (preco === 'varejo' || preco === 'ambos') item.preco = p.price;
  if (preco === 'atacado' || preco === 'ambos') item.preco_atacado = p.wholesale_price;
  if (preco !== 'nenhum') item.moeda = cfg().moeda;
  return item;
}

const PALAVRAS_VAZIAS = new Set(('tem tens teria voce voces vc vcs ai aqui o a os as de da do das dos um uma uns umas '
  + 'qual quais quanto quanta quantos custa custando preco precos valor valores estoque disponivel disponiveis '
  + 'tiene tienen hay el la los las del para pra pro com sem por favor pf pfv me manda mandar ainda quero queria '
  + 'gostaria saber ver tambem e ou que se ta esta estao isso esse essa algum alguma mais').split(' '));

// Busca tolerante: tenta com todas as palavras e, sem resultado, vai
// retirando as menos específicas.
async function buscarCatalogo(texto, limite = 5) {
  // cumprimentos também saem ("oi, boa noite, tem a tamron?" → "tamron")
  const palavras = normalizar(texto).split(' ')
    .filter((w) => w.length >= 2 && !PALAVRAS_VAZIAS.has(w) && !PALAVRAS_SAUDACAO.has(w));
  if (!palavras.length) return [];
  // Nunca desce a uma palavra só quando o cliente escreveu duas ou mais:
  // "mavic 9 ultra" não pode virar "mavic" e listar qualquer drone.
  const minimo = Math.min(palavras.length, 2);
  for (let n = Math.min(palavras.length, 4); n >= minimo && n >= 1; n -= 1) {
    const termos = palavras.slice(0, n);
    const r = (await searchProducts({ query: termos.join(' '), limit: limite * 3 }))
      // a busca também olha a descrição (texto longo): só vale o produto em
      // que os termos aparecem no nome, na marca ou no código
      .filter((p) => {
        const alvo = normalizar(`${p.name} ${p.brand_name || ''} ${p.codigo || ''}`);
        return termos.every((t) => alvo.includes(t));
      })
      .slice(0, limite);
    if (r.length) return r;
  }
  return [];
}

// ------------------------------------------------------------- envio ------
async function enviar(conv, texto, { origem = 'bot', botoes = null } = {}) {
  let resposta;
  if (conv.platform !== 'whatsapp') return; // canal suportado: WhatsApp
  const destino = conv.phone || conv.platform_user_id;
  resposta = botoes
    ? await sendWhatsAppButtons(destino, texto, botoes)
    : await sendWhatsAppText(destino, texto);
  const idApi = resposta && resposta.messages && resposta.messages[0] && resposta.messages[0].id;

  const r = await q.inserirMensagem.run(conv.id, idApi || null, botoes ? 'interactive' : 'text', texto, origem);
  await q.tocarConversa.run(conv.id);
  await broadcast('message', {
    id: Number(r.lastInsertRowid), conversation_id: conv.id, direction: 'out',
    message_type: 'text', content: texto, origin: origem,
  });
  await broadcast('conversation_updated', { conversation_id: conv.id });
}

const registrar = (convId, tipo, entrada, encontrados = null) =>
  q.registrar.run(convId, tipo, entrada ? String(entrada).slice(0, 500) : null, encontrados);

// ----------------------------------------------------------- IA ----------
const FERRAMENTA_BUSCA = {
  name: 'consultar_estoque',
  description:
    'Consulta o catálogo real da loja e devolve produtos com estoque e preço. Use SEMPRE que o cliente '
    + 'perguntar por um produto, marca, modelo, preço ou disponibilidade. Passe palavras-chave curtas '
    + '(marca e modelo), não a frase inteira. Se não achar, tente outra combinação de palavras uma vez.',
  input_schema: {
    type: 'object',
    properties: { termos: { type: 'string', description: 'Ex.: "sony 17-70", "iphone 17 pro", "dji mini".' } },
    required: ['termos'],
  },
};

function promptSistema(abertura) {
  const c = cfg();
  return `Você é o assistente de atendimento da ${c.loja} no WhatsApp. A loja está FECHADA agora e reabre ${abertura}.
Horário de funcionamento: ${descreverHorario()}.
Sua função é informar estoque e preço de produtos consultando a ferramenta consultar_estoque (e, se perguntarem, o horário acima).

Regras:
- Para qualquer pergunta sobre produto, preço ou disponibilidade, use a ferramenta antes de responder. Nunca invente produto, preço, estoque ou prazo.
- Informe o que a ferramenta devolveu: nome, situação do estoque (disponível ou esgotado${c.mostrarQuantidade ? ', com a quantidade' : ''})${c.preco === 'nenhum' ? '' : ' e preço (em ' + c.moeda + ')'}. Se o estoque for 0, diga que está esgotado no momento.
- Não feche pedido, não reserve produto, não combine pagamento, entrega ou desconto. Diga que um atendente confirma isso quando a loja abrir.
- Se não encontrar o produto, diga isso com clareza e sugira escrever a marca e o modelo, ou tocar em "Falar com atendente".
- Fora de estoque e preço (garantia, troca, reclamação, outros assuntos): diga que um atendente responde quando a loja abrir.
- Responda no idioma do cliente (português ou espanhol), em no máximo 5 linhas, sem emojis, tom cordial e direto.
- Não peça nem repita dados pessoais (CPF, endereço, cartão).`;
}

async function chamarIa(mensagens, abertura) {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 25000);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controle.signal,
      headers: anthropic.cabecalhos(),
      body: JSON.stringify({
        model: cfg().modelo,
        max_tokens: 500,
        system: promptSistema(abertura),
        tools: [FERRAMENTA_BUSCA],
        messages: mensagens,
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(limite);
  }
}

// Histórico recente no formato da API: começa no cliente e alterna papéis
// (mensagens seguidas do mesmo lado são juntadas).
async function historicoIa(conversationId) {
  const linhas = (await q.historico.all(conversationId, HISTORICO_HORAS, HISTORICO_LIMITE)).reverse();
  const msgs = [];
  for (const l of linhas) {
    const papel = l.direction === 'in' ? 'user' : 'assistant';
    if (!msgs.length && papel !== 'user') continue;
    const ultimo = msgs[msgs.length - 1];
    if (ultimo && ultimo.role === papel) ultimo.content += `\n${l.content}`;
    else msgs.push({ role: papel, content: l.content });
  }
  if (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
  return msgs;
}

async function responderComIa(conversationId, abertura) {
  let mensagens = await historicoIa(conversationId);
  if (!mensagens.length) return null;
  let encontrados = 0;

  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada += 1) {
    const resp = await chamarIa(mensagens, abertura);
    if (resp.stop_reason !== 'tool_use') {
      const texto = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return texto ? { texto, encontrados } : null;
    }
    const usos = resp.content.filter((b) => b.type === 'tool_use');
    const resultados = [];
    for (const uso of usos) {
      let conteudo;
      if (uso.name === FERRAMENTA_BUSCA.name) {
        const achados = await buscarCatalogo(uso.input && uso.input.termos, 5);
        encontrados += achados.length;
        conteudo = achados.length
          ? JSON.stringify(achados.map(produtoParaCliente))
          : 'Nenhum produto encontrado com esses termos.';
      } else {
        conteudo = 'Ferramenta desconhecida.';
      }
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: conteudo });
    }
    mensagens = [...mensagens, { role: 'assistant', content: resp.content }, { role: 'user', content: resultados }];
  }
  return null;
}

// Resposta sem IA: busca direta e texto montado pelo próprio sistema.
async function responderDireto(texto, abertura) {
  const achados = await buscarCatalogo(texto, 3);
  if (!achados.length) {
    return {
      texto: 'Não encontrei esse produto no catálogo. Tente escrever a marca e o modelo '
        + `(ex.: "Sony 17-70"), ou toque em "Falar com atendente" que respondemos ${abertura}.`,
      encontrados: 0,
    };
  }
  const linhas = achados.map((p) => `- ${p.name}${linhaPreco(p)}: ${linhaEstoque(p.stock)}`);
  return {
    texto: `Encontrei no catálogo:\n${linhas.join('\n')}\n\nPedido e pagamento são confirmados por um atendente quando a loja abrir (${abertura}).`,
    encontrados: achados.length,
  };
}

// ------------------------------------------------------------ principal ---
async function atender(conversationId, msg = {}) {
  const c = cfg();
  if (!c.ativo) return { acao: 'desligado' };
  const agora = new Date();
  if (isWithinBusinessHours(agora)) return { acao: 'loja_aberta' };

  await garantirEsquema();
  const conv = await q.conversa.get(conversationId);
  if (!conv || conv.platform !== 'whatsapp') return { acao: 'canal_nao_suportado' };

  if (await q.humanoRecente.get(conversationId, c.pausaHumanoHoras)) return { acao: 'humano_ativo' };
  if (conv.bot_pausado_ate && new Date(`${String(conv.bot_pausado_ate).replace(' ', 'T')}Z`) > agora) {
    return { acao: 'pausado' };
  }
  if ((await q.botHoje.get(conversationId)).n >= c.limiteDiario) return { acao: 'limite_diario' };

  const abertura = proximaAbertura(agora);
  const texto = msg.text || '';
  const norm = normalizar(texto);

  // 5. pedido de atendente
  if (msg.interactiveId === BOTAO_ATENDENTE || (norm && PEDE_ATENDENTE.test(norm))) {
    await enviar(conv, `Anotado! Um atendente vai responder ${abertura}, quando a loja abrir. `
      + 'Se quiser, já deixe aqui o que precisa.');
    const reabre = dataProximaAbertura(agora) || new Date(agora.getTime() + 12 * 3600 * 1000);
    await q.pausar.run(reabre.toISOString(), conversationId);
    await registrar(conversationId, 'atendente', texto);
    return { acao: 'atendente' };
  }

  // 6. mídia
  if (MIDIA.includes(msg.messageType)) {
    await enviar(conv, 'Ainda não consigo ouvir áudios nem ver imagens. Escreva o nome do produto '
      + 'que eu consulto o estoque, ou toque em "Falar com atendente".', {
      botoes: [{ id: BOTAO_ATENDENTE, label: 'Falar com atendente' }],
    });
    await registrar(conversationId, 'midia', msg.messageType);
    return { acao: 'midia' };
  }

  // 7. boas-vindas: uma vez por período fechado
  const inicioPeriodo = dataUltimoFechamento(agora).toISOString();
  const jaRecebeu = await q.boasVindasNoPeriodo.get(conversationId, inicioPeriodo);
  const soSaudacao = !norm || ehSaudacao(norm);
  if (!jaRecebeu) {
    const nome = primeiroNome(conv.display_name);
    await enviar(conv, `Olá${nome ? `, ${nome}` : ''}! A ${c.loja} está fechada agora e abre ${abertura}. `
      + 'Enquanto isso, posso consultar estoque e preço para você.', {
      botoes: [{ id: BOTAO_ESTOQUE, label: 'Consultar estoque' }, { id: BOTAO_ATENDENTE, label: 'Falar com atendente' }],
    });
    await registrar(conversationId, 'boas_vindas', texto);
    if (soSaudacao) return { acao: 'boas_vindas' };
  }

  // 7b. pergunta sobre horário: resposta pronta com o horário configurado
  if (norm && norm.length <= 80 && PERGUNTA_HORARIO.test(norm)) {
    await enviar(conv, `Funcionamos de ${descreverHorario()}. Agora estamos fechados e abrimos ${abertura}. `
      + 'Enquanto isso, posso consultar estoque e preço para você.');
    await registrar(conversationId, 'horario', texto);
    return { acao: 'horario' };
  }

  // 8. botão consultar estoque, ou só cumprimento
  if (msg.interactiveId === BOTAO_ESTOQUE || soSaudacao || PEDE_CONSULTA.test(norm)) {
    await enviar(conv, 'Me diga o nome, a marca ou o modelo do produto (ex.: "Sony 17-70" ou "iPhone 17").');
    await registrar(conversationId, 'pedido_produto', texto);
    return { acao: 'pedido_produto' };
  }

  // 9. consulta ao catálogo
  let resposta = null;
  let tipo = 'consulta_direta';
  if (c.usarIa) {
    try {
      resposta = await responderComIa(conversationId, abertura);
      tipo = 'consulta_ia';
    } catch (err) {
      logger.error('chatbot: falha na IA, usando consulta direta:', err.message);
      await registrar(conversationId, 'erro_ia', err.message);
    }
  }
  if (!resposta) {
    resposta = await responderDireto(texto, abertura);
    tipo = 'consulta_direta';
  }
  await enviar(conv, resposta.texto, {
    origem: tipo === 'consulta_ia' ? 'ai' : 'bot',
    botoes: resposta.encontrados === 0 ? [{ id: BOTAO_ATENDENTE, label: 'Falar com atendente' }] : null,
  });
  await registrar(conversationId, resposta.encontrados === 0 ? 'sem_resultado' : tipo, texto, resposta.encontrados);
  return { acao: tipo, encontrados: resposta.encontrados };
}

// --------------------------------------------- fila por conversa ----------
// Mensagens da MESMA conversa são atendidas uma de cada vez. Sem isso, três
// mensagens chegando juntas passavam todas pela checagem "já mandou as
// boas-vindas?" antes de a primeira terminar de enviar e o cliente recebia
// três boas-vindas.
const cadeias = new Map(); // conversationId -> Promise do último atendimento
function enfileirar(conversationId, tarefa) {
  const anterior = cadeias.get(conversationId) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  cadeias.set(conversationId, atual);
  atual.finally(() => { if (cadeias.get(conversationId) === atual) cadeias.delete(conversationId); }).catch(() => {});
  return atual;
}

// Rajada: mensagens que chegam em poucos segundos ("oi" + "tem a tamron?")
// viram um atendimento só, com os textos juntos.
const INVISIVEIS = /[\s\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const temTexto = (t) => String(t || '').replace(INVISIVEIS, '').length > 0;
const agruparMs = () => {
  const v = process.env.CHATBOT_AGRUPAR_MS;
  return v === undefined || v === '' ? 2000 : Math.max(0, Number(v) || 0);
};
function juntar(msgs) {
  const botao = [...msgs].reverse().find((m) => m.interactiveId);
  if (botao) return botao; // toque em botão/opção vale por si
  const textos = msgs.filter((m) => temTexto(m.text)).map((m) => String(m.text).trim());
  const ultima = msgs[msgs.length - 1];
  if (!textos.length) return ultima;
  return { ...ultima, messageType: 'text', text: textos.join('\n') };
}
const rajadas = new Map(); // conversationId -> { msgs, avisos, timer }

async function atenderSeguro(conversationId, msg) {
  try {
    return await atender(conversationId, msg);
  } catch (err) {
    logger.error('chatbot: falha ao atender:', err.message);
    return { acao: 'erro' };
  }
}

// Ponto de entrada usado pelo webhook: nunca derruba o processamento.
function maybeRespond(conversationId, msg = {}) {
  // Mensagem sem texto, sem mídia e sem botão (aviso interno do WhatsApp,
  // reação, caractere invisível): o bot não responde.
  if (!temTexto(msg.text) && !msg.interactiveId && !MIDIA.includes(msg.messageType)) {
    return Promise.resolve({ acao: 'sem_conteudo' });
  }
  const espera = agruparMs();
  if (!espera) return enfileirar(conversationId, () => atenderSeguro(conversationId, msg));
  return new Promise((resolve) => {
    let r = rajadas.get(conversationId);
    if (!r) { r = { msgs: [], avisos: [] }; rajadas.set(conversationId, r); }
    r.msgs.push(msg);
    r.avisos.push(resolve);
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      rajadas.delete(conversationId);
      enfileirar(conversationId, () => atenderSeguro(conversationId, juntar(r.msgs)))
        .then((resultado) => r.avisos.forEach((f) => f(resultado)));
    }, espera);
  });
}

module.exports = { maybeRespond, atender, buscarCatalogo, garantirEsquema, BOTAO_ESTOQUE, BOTAO_ATENDENTE };
