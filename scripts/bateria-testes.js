// =============================================================================
//  Bateria de testes do protótipo — 52 casos (Tabela 4 do TCC)
// =============================================================================
//  Uso:   npm run test:bateria
//
//  Segurança da execução
//  - Roda numa base SEPARADA (padrão: crm_teste), nunca na base da empresa.
//    Crie uma vez no pgAdmin/psql:  CREATE DATABASE crm_teste OWNER crm;
//    A migração da base de teste é aplicada automaticamente.
//  - Nenhuma mensagem real é enviada: as chamadas à Graph API da Meta são
//    interceptadas e respondidas pelo próprio teste.
//  - Os testes de interface HTTP sobem uma cópia do servidor na porta 3999,
//    também apontada para a base de teste e sem tokens reais.
//
//  Saída
//  - Tabela no terminal, com o resumo por grupo (formato da Tabela 4).
//  - testes/resultados/bateria-AAAA-MM-DD.json  (evidência completa)
//  - testes/resultados/apendice-casos-de-teste.tex  (Apêndice: casos de teste)
//  - testes/resultados/apendice-checklist-lgpd.tex  (Apêndice: checklist LGPD)
// =============================================================================

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------- ambiente --
// Definido ANTES do dotenv, que não sobrescreve variáveis já existentes: assim
// os tokens reais do .env nunca são usados por esta bateria.
const BASE_TESTE = process.env.PGDATABASE_TESTE || 'crm_teste';
Object.assign(process.env, {
  PGDATABASE: BASE_TESTE,
  DATABASE_URL: '', // vazio (e não ausente) para o .env não apontar para a base real
  WHATSAPP_ACCESS_TOKEN: 'token-de-teste',
  WHATSAPP_PHONE_NUMBER_ID: 'PHONE_ID_TESTE',
  META_APP_SECRET: 'segredo-de-teste',
  META_VERIFY_TOKEN: 'verifica-teste',
  ANTHROPIC_API_KEY: '',
  CAMPAIGN_SEND_DELAY_MS: '0',
  PUBLIC_BASE_URL: 'http://127.0.0.1:3999',
  CATALOGO_XML_URL: '',
  GENOVE_API_KEY: '',
  CHATBOT_ENABLED: 'false',
});
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const RAIZ = path.join(__dirname, '..');
const PORTA_HTTP = 3999;
const URL_HTTP = `http://127.0.0.1:${PORTA_HTTP}`;

// ------------------------------------------- interceptação da Graph API ----
const fetchOriginal = globalThis.fetch;
const chamadasGraph = [];
const numerosQueFalham = new Set();
let contadorWamid = 0;

globalThis.fetch = async (url, opcoes = {}) => {
  const alvo = String(url);
  if (alvo.startsWith('https://graph.facebook.com/')) {
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadasGraph.push({ url: alvo, headers: opcoes.headers || {}, corpo });
    if (corpo && numerosQueFalham.has(corpo.to)) {
      return new Response(JSON.stringify({ error: { code: 131049, message: 'falha simulada' } }), { status: 400 });
    }
    contadorWamid += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.teste.${Date.now()}.${contadorWamid}` }] }), { status: 200 });
  }
  if (alvo.startsWith(URL_HTTP)) return fetchOriginal(url, opcoes);
  throw new Error(`Bateria de testes: acesso externo bloqueado (${alvo})`);
};

// ------------------------------------------------------------- harness -----
const casos = [];
function caso(id, grupo, requisitos, descricao, esperado, fn) {
  casos.push({ id, grupo, requisitos, descricao, esperado, fn });
}
const garantir = (condicao, obtido) => {
  if (!condicao) { const e = new Error(obtido); e.obtido = obtido; throw e; }
  return obtido;
};
async function lancaErro(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// ------------------------------------------------------- base de teste -----
function migrarBaseDeTeste() {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'src', 'db', 'migrate.js')], {
    cwd: RAIZ, env: process.env, encoding: 'utf8',
  });
  if (r.status !== 0) {
    const msg = `${r.stdout || ''}${r.stderr || ''}`;
    console.error(`\nNão foi possível preparar a base "${BASE_TESTE}".\n${msg}`);
    if (/does not exist|não existe/i.test(msg)) {
      console.error(`Crie a base de teste uma vez (pgAdmin ou psql):\n  CREATE DATABASE ${BASE_TESTE} OWNER ${process.env.PGUSER || 'crm'};\n`);
    }
    process.exit(2);
  }
}

// =============================================================================
(async () => {
  migrarBaseDeTeste();

  const db = require('../src/db');
  const consent = require('../src/services/consent');
  const segmentation = require('../src/services/segmentation');
  const { renderizar } = require('../src/services/templateRenderer');
  const engine = require('../src/services/campaignEngine');
  const metrics = require('../src/services/campaignMetrics');
  const { hashPassword } = require('../src/utils/password');

  const MARCA = `t${Date.now()}`;
  let seq = 0;
  const telefone = () => `5599${String(Date.now()).slice(-7)}${String(++seq).padStart(3, '0')}`;

  async function novoContato(dados = {}) {
    const fone = telefone();
    const r = await db.prepare(`
      INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil, interesse_declarado, anonimizado, ultima_interacao)
      VALUES ('whatsapp', ?, ?, ?, ?, ?, ?, now())
    `).run(fone, dados.nome === undefined ? `Contato ${seq}` : dados.nome, fone,
      dados.perfil || MARCA, dados.interesse || null, dados.anonimizado ? 1 : 0);
    return { id: Number(r.lastInsertRowid), telefone: fone };
  }
  const optIn = (id) => consent.registrar({ contactId: id, tipo: 'opt_in', finalidade: 'bateria de testes', origem: MARCA });
  const optOut = (id) => consent.registrar({ contactId: id, tipo: 'opt_out', finalidade: 'bateria de testes', origem: MARCA });

  async function novoSegmento(perfil) {
    const r = await db.prepare('INSERT INTO segmentos (nome, descricao) VALUES (?, ?)').run(`seg ${perfil} ${seq++}`, 'bateria de testes');
    const id = Number(r.lastInsertRowid);
    await db.prepare(`INSERT INTO regras_segmentacao (segmento_id, atributo, operador, valor_referencia, ordem) VALUES (?, 'perfil', 'igual', ?, 0)`).run(id, perfil);
    return id;
  }
  async function novoModelo(situacao = 'aprovado') {
    const r = await db.prepare(`
      INSERT INTO modelos_mensagem (nome, corpo, parametros, situacao_aprovacao)
      VALUES (?, 'Ola {{1}}, confira: {{2}}', '["display_name","_link"]', ?)
    `).run(`modelo_${MARCA}_${seq++}`, situacao);
    return Number(r.lastInsertRowid);
  }
  async function novaCampanha(segmentoId, modeloId, cenario = 'automatizado') {
    const r = await db.prepare(`
      INSERT INTO campanhas (nome, segmento_id, modelo_id, cenario, url_destino, situacao)
      VALUES (?, ?, ?, ?, 'https://exemplo.test/oferta', 'rascunho')
    `).run(`campanha ${MARCA} ${seq++}`, segmentoId, modeloId, cenario);
    return Number(r.lastInsertRowid);
  }
  const enviosDe = (campanhaId) => db.prepare('SELECT * FROM envios WHERE campanha_id = ? ORDER BY id').all(campanhaId);

  // Estado compartilhado entre os casos (preenchido ao longo da bateria).
  const S = {};

  // =========================================================== CONSENTIMENTO
  const G1 = ['Consentimento', 'RF02'];
  caso('T01', ...G1, 'Opt-in é gravado com tipo, finalidade, origem e data/hora', 'registro com os quatro campos preenchidos', async () => {
    S.cBase = await novoContato();
    const id = await optIn(S.cBase.id);
    const r = await db.prepare('SELECT * FROM consentimentos WHERE id = ?').get(id);
    return garantir(r.tipo === 'opt_in' && r.finalidade && r.origem === MARCA && r.data_hora,
      `tipo=${r.tipo}; finalidade="${r.finalidade}"; origem preenchida; data_hora=${r.data_hora}`);
  });
  caso('T02', ...G1, 'Tipo de manifestação inválido é recusado', 'erro de validação', async () => {
    const e = await lancaErro(() => consent.registrar({ contactId: S.cBase.id, tipo: 'talvez', origem: MARCA }));
    return garantir(e, e ? `recusado: ${e.message}` : 'aceito indevidamente');
  });
  caso('T03', ...G1, 'Manifestação sem origem é recusada', 'erro de validação', async () => {
    const e = await lancaErro(() => consent.registrar({ contactId: S.cBase.id, tipo: 'opt_in' }));
    return garantir(e, e ? `recusado: ${e.message}` : 'aceito indevidamente');
  });
  caso('T04', ...G1, 'Contato sem nenhuma manifestação é inelegível (sem consentimento presumido)', 'estaElegivel = false', async () => {
    const c = await novoContato();
    const v = await consent.estaElegivel(c.id);
    return garantir(v === false, `estaElegivel = ${v}`);
  });
  caso('T05', ...G1, 'Contato com opt-in vigente é elegível', 'estaElegivel = true', async () => {
    const v = await consent.estaElegivel(S.cBase.id);
    return garantir(v === true, `estaElegivel = ${v}`);
  });
  caso('T06', ...G1, 'Opt-out posterior torna o contato inelegível (vale a manifestação mais recente), também na consulta em lote', 'false na verificação individual e na consulta da segmentação', async () => {
    const c = await novoContato({ perfil: `${MARCA}-t06` });
    await optIn(c.id); await optOut(c.id);
    const ind = await consent.estaElegivel(c.id);
    const lote = await segmentation.resolverRegras([{ atributo: 'perfil', operador: 'igual', valor_referencia: `${MARCA}-t06` }], { somenteElegiveis: true });
    return garantir(ind === false && lote.length === 0, `individual=${ind}; consulta em lote retornou ${lote.length} contato(s)`);
  });
  caso('T07', ...G1, 'Novo opt-in após revogação restabelece a elegibilidade', 'estaElegivel = true', async () => {
    const c = await novoContato();
    await optIn(c.id); await optOut(c.id); await optIn(c.id);
    const v = await consent.estaElegivel(c.id);
    return garantir(v === true, `estaElegivel = ${v}`);
  });
  caso('T08', ...G1, 'Histórico preserva todas as manifestações, da mais recente para a mais antiga', '3 registros: opt_in, opt_out, opt_in', async () => {
    const c = await novoContato();
    await optIn(c.id); await optOut(c.id); await optIn(c.id);
    const h = await consent.historico(c.id);
    const tipos = h.map((x) => x.tipo).join(', ');
    return garantir(h.length === 3 && tipos === 'opt_in, opt_out, opt_in', `${h.length} registro(s): ${tipos}`);
  });
  caso('T09', ...G1, 'Envio manual pelo inbox a contato sem opt-in é recusado (RNF02)', 'erro e nenhum envio gravado', async () => {
    const c = await novoContato();
    const seg = await novoSegmento(`${MARCA}-t09`);
    const camp = await novaCampanha(seg, await novoModelo(), 'manual');
    const e = await lancaErro(() => engine.registrarEnvioManual({ campanhaId: camp, contactId: c.id, conteudo: 'oferta' }));
    const n = (await enviosDe(camp)).length;
    return garantir(e && n === 0, `${e ? `recusado: ${e.message}` : 'aceito'}; envios gravados = ${n}`);
  });

  // ============================================================ SEGMENTAÇÃO
  const G2 = ['Segmentação e elegibilidade', 'RF03, RF06'];
  caso('T10', ...G2, 'Regra "perfil igual a" retorna somente os contatos do perfil', '3 contatos do perfil, nenhum de outro perfil', async () => {
    S.perfilSeg = `${MARCA}-seg`;
    await novoContato({ perfil: S.perfilSeg, interesse: 'câmeras, lentes' });
    await novoContato({ perfil: S.perfilSeg, interesse: 'iPhone' });
    await novoContato({ perfil: S.perfilSeg, interesse: 'câmeras' });
    await novoContato({ perfil: `${MARCA}-outro`, interesse: 'câmeras' });
    const r = await segmentation.resolverRegras([{ atributo: 'perfil', operador: 'igual', valor_referencia: S.perfilSeg }]);
    return garantir(r.length === 3 && r.every((c) => c.perfil === S.perfilSeg), `${r.length} contato(s) retornado(s)`);
  });
  caso('T11', ...G2, 'Conjunção de regras (perfil E interesse "câmeras") restringe o segmento', '2 contatos', async () => {
    const r = await segmentation.resolverRegras([
      { atributo: 'perfil', operador: 'igual', valor_referencia: S.perfilSeg },
      { atributo: 'interesse_declarado', operador: 'possui', valor_referencia: 'câmeras' },
    ]);
    return garantir(r.length === 2, `${r.length} contato(s) retornado(s)`);
  });
  caso('T12', ...G2, 'Atributo ou operador fora da lista branca é recusado (proteção contra injeção de SQL)', 'erro nos dois casos', async () => {
    const e1 = await lancaErro(() => segmentation.resolverRegras([{ atributo: 'phone; DROP TABLE contacts', operador: 'igual', valor_referencia: 'x' }]));
    const e2 = await lancaErro(() => segmentation.resolverRegras([{ atributo: 'perfil', operador: 'OR 1=1 --', valor_referencia: 'x' }]));
    return garantir(e1 && e2, `atributo: ${e1 ? 'recusado' : 'aceito'}; operador: ${e2 ? 'recusado' : 'aceito'}`);
  });

  // ===================================================== MODELOS E PERSONALIZAÇÃO
  const G3 = ['Modelos e personalização', 'RF04, RF07, RNF03'];
  const modeloTeste = { corpo: 'Ola {{1}}, confira: {{2}}', parametros: '["display_name","_link"]' };
  caso('T13', ...G3, 'Parâmetros {{1}} e {{2}} são substituídos pelo nome do contato e pelo link rastreado', '"Ola Maria Souza, confira: https://x.test/r/abc"', async () => {
    const r = renderizar(modeloTeste, { display_name: 'Maria Souza' }, { link: 'https://x.test/r/abc' });
    return garantir(r.texto === 'Ola Maria Souza, confira: https://x.test/r/abc', `"${r.texto}"`);
  });
  caso('T14', ...G3, 'Parâmetro fora da lista permitida (ex.: cpf) é recusado', 'erro', async () => {
    const e = await lancaErro(async () => renderizar({ corpo: '{{1}}', parametros: '["cpf"]' }, {}, {}));
    return garantir(e, e ? `recusado: ${e.message}` : 'aceito indevidamente');
  });
  caso('T15', ...G3, 'Componentes gerados no formato exigido pela Cloud API', 'type "body" com 2 parâmetros type "text"', async () => {
    const r = renderizar(modeloTeste, { display_name: 'Ana' }, { link: 'L' });
    const c = r.componentes[0];
    return garantir(r.componentes.length === 1 && c.type === 'body' && c.parameters.length === 2 && c.parameters.every((p) => p.type === 'text'),
      `${r.componentes.length} componente "${c.type}" com ${c.parameters.length} parâmetros do tipo "${c.parameters.map((x) => x.type).join('", "')}"`);
  });
  caso('T16', ...G3, 'Contato sem nome recebe o valor padrão "cliente"', '"Ola cliente, ..."', async () => {
    const r = renderizar(modeloTeste, { display_name: null }, { link: 'L' });
    return garantir(r.texto.startsWith('Ola cliente,'), `"${r.texto}"`);
  });

  // ======================================================= EXECUÇÃO DE CAMPANHA
  const G4 = ['Execução de campanha', 'RF05, RF06, RF08, RF11, RNF02'];
  caso('T17', ...G4, 'Campanha com 4 contatos no segmento (2 com opt-in, 1 revogado, 1 sem registro) envia exatamente 2', 'enviados = 2; não elegíveis = 2', async () => {
    S.perfilA = `${MARCA}-A`;
    S.A = [];
    for (let i = 0; i < 4; i += 1) S.A.push(await novoContato({ perfil: S.perfilA, nome: `Cliente A${i + 1}` }));
    await optIn(S.A[0].id); await optIn(S.A[1].id); await optIn(S.A[2].id); await optOut(S.A[2].id);
    S.segA = await novoSegmento(S.perfilA);
    S.modA = await novoModelo();
    S.campA = await novaCampanha(S.segA, S.modA);
    S.chamadasAntesA = chamadasGraph.length;
    S.resumoA = await engine.executarCampanha(S.campA);
    return garantir(S.resumoA.enviados === 2 && S.resumoA.nao_elegiveis === 2,
      `enviados=${S.resumoA.enviados}; nao_elegiveis=${S.resumoA.nao_elegiveis}; falhas=${S.resumoA.falhas}`);
  });
  caso('T18', ...G4, 'Contatos bloqueados são registrados com o motivo discriminado', '"consentimento revogado (opt-out)" e "sem opt-in registrado"', async () => {
    const m = (await enviosDe(S.campA)).filter((e) => e.situacao === 'nao_elegivel').map((e) => e.motivo).sort();
    return garantir(m.length === 2 && m.includes('consentimento revogado (opt-out)') && m.includes('sem opt-in registrado'), m.join(' / '));
  });
  caso('T19', ...G4, 'Nenhuma chamada à Cloud API é feita para contatos inelegíveis', '2 chamadas, ambas para contatos com opt-in', async () => {
    S.chamadasA = chamadasGraph.slice(S.chamadasAntesA);
    const destinos = S.chamadasA.map((c) => c.corpo.to);
    const permitidos = [S.A[0].telefone, S.A[1].telefone];
    return garantir(destinos.length === 2 && destinos.every((d) => permitidos.includes(d)),
      `${destinos.length} chamada(s); destinos elegíveis: ${destinos.every((d) => permitidos.includes(d))}`);
  });
  caso('T20', ...G4, 'O identificador devolvido pela Cloud API é gravado em cada envio', 'id_api preenchido nos 2 envios', async () => {
    S.enviosA = (await enviosDe(S.campA)).filter((e) => e.situacao === 'enviado');
    return garantir(S.enviosA.length === 2 && S.enviosA.every((e) => /^wamid\./.test(e.id_api || '')), `2 envios com id_api no formato wamid (ex.: ${S.enviosA[0].id_api.slice(0, 18)}...)`);
  });
  caso('T21', ...G4, 'Cada envio recebe um link rastreado com token único, incluído no texto enviado', '2 tokens distintos presentes nos textos', async () => {
    const links = await db.prepare(`SELECT l.* FROM links_rastreados l JOIN envios e ON e.id = l.envio_id WHERE e.campanha_id = ?`).all(S.campA);
    S.linksA = links;
    const distintos = new Set(links.map((l) => l.token)).size;
    const noTexto = links.every((l) => S.enviosA.some((e) => (e.conteudo || '').includes(`/r/${l.token}`)));
    return garantir(links.length === 2 && distintos === 2 && noTexto, `${links.length} link(s); ${distintos} token(s) distinto(s); presentes no texto: ${noTexto}`);
  });
  caso('T22', ...G4, 'A execução gera registro com início, fim, resultado e resumo (RF11)', 'resultado "concluida" com resumo', async () => {
    const r = await db.prepare('SELECT * FROM registros_execucao_fluxo WHERE campanha_id = ? ORDER BY id DESC LIMIT 1').get(S.campA);
    const d = r && JSON.parse(r.detalhe || '{}');
    return garantir(r && r.inicio && r.fim && r.resultado === 'concluida' && d.enviados === 2,
      `resultado=${r && r.resultado}; início e fim registrados; resumo: total ${d.total}, enviados ${d.enviados}, não elegíveis ${d.nao_elegiveis}, falhas ${d.falhas}`);
  });
  caso('T23', ...G4, 'Reexecutar a campanha não reenvia aos contatos já processados', 'enviados = 0; já processados = 4', async () => {
    await db.prepare("UPDATE campanhas SET situacao = 'agendada' WHERE id = ?").run(S.campA);
    const antes = chamadasGraph.length;
    const r = await engine.executarCampanha(S.campA);
    return garantir(r.enviados === 0 && r.ja_processados === 4 && chamadasGraph.length === antes,
      `enviados=${r.enviados}; ja_processados=${r.ja_processados}; novas chamadas à API=${chamadasGraph.length - antes}`);
  });
  caso('T24', ...G4, 'Recusa da Cloud API é registrada como falha, com motivo e evento, sem interromper a campanha', 'envio "falha" com motivo; evento "falha"', async () => {
    const perfil = `${MARCA}-falha`;
    const ok1 = await novoContato({ perfil }); const ruim = await novoContato({ perfil });
    await optIn(ok1.id); await optIn(ruim.id);
    numerosQueFalham.add(ruim.telefone);
    const camp = await novaCampanha(await novoSegmento(perfil), await novoModelo());
    const r = await engine.executarCampanha(camp);
    const env = (await enviosDe(camp)).find((e) => e.contact_id === ruim.id);
    const ev = await db.prepare("SELECT COUNT(*)::int AS n FROM eventos_interacao WHERE campanha_id = ? AND tipo = 'falha'").get(camp);
    return garantir(r.enviados === 1 && r.falhas === 1 && env.situacao === 'falha' && /400/.test(env.motivo) && ev.n === 1,
      `enviados=${r.enviados}; falhas=${r.falhas}; motivo gravado: HTTP 400, código ${((env.motivo || '').match(/"code":(\d+)/) || [])[1]}; eventos de falha=${ev.n}`);
  });

  // =========================================================== EVENTOS E CLIQUES
  const G5 = ['Eventos e cliques', 'RF09'];
  caso('T25', ...G5, 'Notificações de entrega e leitura geram eventos vinculados ao envio, à campanha e ao contato', 'eventos "entregue" e "lido" com os três vínculos', async () => {
    const e = S.enviosA[0];
    await engine.registrarStatusWebhook({ platformMessageId: e.id_api, status: 'delivered' });
    await engine.registrarStatusWebhook({ platformMessageId: e.id_api, status: 'read' });
    const evs = await db.prepare("SELECT * FROM eventos_interacao WHERE envio_id = ? AND tipo IN ('entregue','lido')").all(e.id);
    return garantir(evs.length === 2 && evs.every((v) => v.campanha_id === S.campA && v.contact_id === e.contact_id),
      `${evs.length} evento(s): ${evs.map((v) => v.tipo).join(', ')}`);
  });
  caso('T26', ...G5, 'Reentrega da mesma notificação pela Meta não duplica o evento (idempotência)', 'segunda notificação ignorada; 1 evento', async () => {
    const e = S.enviosA[0];
    const novo = await engine.registrarStatusWebhook({ platformMessageId: e.id_api, status: 'delivered' });
    const n = await db.prepare("SELECT COUNT(*)::int AS n FROM eventos_interacao WHERE envio_id = ? AND tipo = 'entregue'").get(e.id);
    return garantir(novo === false && n.n === 1, `segunda notificação registrada=${novo}; eventos "entregue"=${n.n}`);
  });
  caso('T27', ...G5, 'Acesso ao link rastreado registra o clique e devolve o destino original', 'destino "https://exemplo.test/oferta" e evento "clique"', async () => {
    const link = S.linksA[0];
    const destino = await engine.registrarClique(link.token);
    const n = await db.prepare("SELECT COUNT(*)::int AS n FROM eventos_interacao WHERE link_id = ? AND tipo = 'clique'").get(link.id);
    return garantir(destino === 'https://exemplo.test/oferta' && n.n === 1, `destino=${destino}; eventos de clique=${n.n}`);
  });

  // ===================================================================== MÉTRICAS
  const G6 = ['Métricas', 'RF10'];
  caso('T28', ...G6, 'Campanha com resultado conhecido (4 envios, 2 respostas, 3 leituras) produz as taxas calculadas à mão', 'resposta 0,5; leituras 3', async () => {
    const perfil = `${MARCA}-B`;
    S.B = [];
    for (let i = 0; i < 4; i += 1) { const c = await novoContato({ perfil }); await optIn(c.id); S.B.push(c); }
    S.campB = await novaCampanha(await novoSegmento(perfil), await novoModelo());
    await engine.executarCampanha(S.campB);
    S.enviosB = await enviosDe(S.campB);
    for (const e of S.enviosB) await engine.registrarStatusWebhook({ platformMessageId: e.id_api, status: 'delivered' });
    for (const e of S.enviosB.slice(0, 3)) await engine.registrarStatusWebhook({ platformMessageId: e.id_api, status: 'read' });
    await engine.registrarResposta(S.B[0].id, { teste: 1 });
    await engine.registrarResposta(S.B[1].id, { teste: 2 });
    const m = await metrics.recalcular(S.campB);
    return garantir(m.total_enviados === 4 && m.taxa_resposta === 0.5 && m.total_lidos === 3,
      `enviados=${m.total_enviados}; taxa_resposta=${m.taxa_resposta}; lidos=${m.total_lidos}`);
  });
  caso('T29', ...G6, 'Somente a primeira resposta a cada envio é contabilizada', 'segunda resposta ignorada; taxa inalterada', async () => {
    const novo = await engine.registrarResposta(S.B[0].id, { teste: 'segunda' });
    const m = await metrics.recalcular(S.campB);
    return garantir(novo === false && m.taxa_resposta === 0.5, `segunda resposta registrada=${novo}; taxa_resposta=${m.taxa_resposta}`);
  });
  caso('T30', ...G6, 'Vários cliques no mesmo envio contam uma única vez na taxa de clique', '3 cliques em 2 envios → taxa 0,5', async () => {
    const links = await db.prepare(`SELECT l.* FROM links_rastreados l JOIN envios e ON e.id = l.envio_id WHERE e.campanha_id = ? ORDER BY e.id`).all(S.campB);
    await engine.registrarClique(links[0].token);
    await engine.registrarClique(links[0].token);
    await engine.registrarClique(links[2].token);
    const m = await metrics.recalcular(S.campB);
    return garantir(m.total_cliques === 2 && m.taxa_clique === 0.5, `cliques distintos=${m.total_cliques}; taxa_clique=${m.taxa_clique}`);
  });
  caso('T31', ...G6, 'Conversão registrada entra na taxa; envio não efetivado não aceita conversão', 'taxa de conversão 0,25; recusa no envio bloqueado', async () => {
    await engine.registrarConversao({ envioId: S.enviosB[0].id, origem: 'manual' });
    const m = await metrics.recalcular(S.campB);
    const bloqueado = (await enviosDe(S.campA)).find((e) => e.situacao === 'nao_elegivel');
    const e = await lancaErro(() => engine.registrarConversao({ envioId: bloqueado.id }));
    return garantir(m.taxa_conversao === 0.25 && e, `taxa_conversao=${m.taxa_conversao}; conversão em envio bloqueado: ${e ? 'recusada' : 'aceita'}`);
  });
  caso('T32', ...G6, 'Tempo médio até a primeira resposta é calculado a partir dos eventos', 'valor numérico ≥ 0', async () => {
    const m = await metrics.recalcular(S.campB);
    return garantir(typeof m.tempo_medio_resposta === 'number' && m.tempo_medio_resposta >= 0, `tempo_medio_resposta=${m.tempo_medio_resposta} s`);
  });
  caso('T33', ...G6, 'Recontagem independente a partir dos eventos brutos coincide com as métricas gravadas', 'totais idênticos', async () => {
    const bruto = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM envios WHERE campanha_id = ? AND situacao = 'enviado')::int AS enviados,
        (SELECT COUNT(DISTINCT envio_id) FROM eventos_interacao WHERE campanha_id = ? AND tipo = 'resposta')::int AS respostas,
        (SELECT COUNT(DISTINCT envio_id) FROM eventos_interacao WHERE campanha_id = ? AND tipo = 'clique')::int AS cliques,
        (SELECT COUNT(DISTINCT envio_id) FROM eventos_interacao WHERE campanha_id = ? AND tipo = 'lido')::int AS lidos,
        (SELECT COUNT(*) FROM conversoes WHERE campanha_id = ?)::int AS conversoes
    `).get(S.campB, S.campB, S.campB, S.campB, S.campB);
    const m = await db.prepare('SELECT * FROM metricas_campanha WHERE campanha_id = ?').get(S.campB);
    const iguais = bruto.enviados === m.total_enviados && bruto.respostas === m.total_respostas &&
      bruto.cliques === m.total_cliques && bruto.lidos === m.total_lidos && bruto.conversoes === m.total_conversoes;
    return garantir(iguais, `recontagem e tabela iguais: enviados ${bruto.enviados}/${m.total_enviados}, respostas ${bruto.respostas}/${m.total_respostas}, cliques ${bruto.cliques}/${m.total_cliques}, lidos ${bruto.lidos}/${m.total_lidos}, conversões ${bruto.conversoes}/${m.total_conversoes}`);
  });

  // ================================================== MINIMIZAÇÃO E SEGURANÇA
  const G7 = ['Minimização e segurança', 'RNF01, RNF02'];
  caso('T34', ...G7, 'Cadastro de contatos não possui campos de documento, endereço ou e-mail', 'nenhuma coluna desse tipo; coluna "anonimizado" presente', async () => {
    const cols = (await db.prepare("SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'contacts'").all()).map((x) => x.c);
    const proibidas = cols.filter((c) => /cpf|cnpj|rg$|documento|endereco|email|nascimento/i.test(c));
    return garantir(!proibidas.length && cols.includes('anonimizado'), `colunas: ${cols.join(', ')}`);
  });
  caso('T35', ...G7, 'Contato anonimizado não entra em segmento e o banco recusa envio a ele', 'segmento vazio; inserção recusada pelo gatilho', async () => {
    const perfil = `${MARCA}-anon`;
    const c = await novoContato({ perfil, anonimizado: true });
    await optIn(c.id);
    const seg = await segmentation.resolverRegras([{ atributo: 'perfil', operador: 'igual', valor_referencia: perfil }]);
    const e = await lancaErro(() => db.prepare("INSERT INTO envios (campanha_id, contact_id, situacao) VALUES (?, ?, 'enviado')").run(S.campA, c.id));
    return garantir(seg.length === 0 && e, `contatos no segmento=${seg.length}; inserção direta: ${e ? `recusada (${e.message})` : 'aceita'}`);
  });
  caso('T36', ...G7, 'Credenciais ficam fora do código-fonte e do versionamento (.env ignorado pelo Git e pelo Docker)', 'nenhum segredo no código; .env nos dois arquivos de exclusão', async () => {
    const padroes = [/EAA[A-Za-z0-9]{30,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /(APP_SECRET|ACCESS_TOKEN|API_KEY)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/];
    const achados = [];
    const varrer = (dir) => {
      for (const nome of fs.readdirSync(dir)) {
        if (['node_modules', 'vendor', '.git', 'testes'].includes(nome)) continue;
        const p = path.join(dir, nome);
        if (fs.statSync(p).isDirectory()) varrer(p);
        else if (/\.(js|html|json|sql|yml|yaml|md)$/.test(nome) && !nome.endsWith('package-lock.json')) {
          // Valores fictícios usados pelos próprios testes ("segredo-de-teste") não contam.
          const t = fs.readFileSync(p, 'utf8').replace(/['"][^'"\n]*(test|falsa|exemplo|troque)[^'"\n]*['"]/gi, "''");
          if (padroes.some((re) => re.test(t))) achados.push(path.relative(RAIZ, p));
        }
      }
    };
    varrer(RAIZ);
    const ler = (f) => (fs.existsSync(path.join(RAIZ, f)) ? fs.readFileSync(path.join(RAIZ, f), 'utf8') : '');
    const ignorado = /^\.env$/m.test(ler('.gitignore')) && /^\.env$/m.test(ler('.dockerignore'));
    return garantir(!achados.length && ignorado, `arquivos com possível segredo: ${achados.length ? achados.join(', ') : 'nenhum'}; .env ignorado: ${ignorado}`);
  });
  caso('T37', ...G7, 'Exportação para análise (npm run exportar) não contém nome nem telefone dos contatos', 'nenhuma coluna de nome ou telefone nos arquivos CSV exportados', async () => {
    const pastaExp = path.join(require('node:os').tmpdir(), `exportacao-${MARCA}`);
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'exportar-dados.js'), '--pasta', pastaExp], { cwd: RAIZ, env: process.env, encoding: 'utf8' });
    if (r.status !== 0) return garantir(false, `exportação falhou: ${(r.stderr || r.stdout).slice(0, 120)}`);
    const csvs = fs.readdirSync(pastaExp).filter((f) => f.endsWith('.csv'));
    const achadas = [];
    for (const f of csvs) {
      const cab = (fs.readFileSync(path.join(pastaExp, f), 'utf8').split('\n')[0] || '').split(',');
      for (const c of cab) if (['display_name', 'phone', 'contato', 'platform_user_id'].includes(c)) achadas.push(`${f}:${c}`);
    }
    fs.rmSync(pastaExp, { recursive: true, force: true });
    return garantir(csvs.length && !achadas.length, achadas.length ? `colunas identificadoras: ${achadas.join(', ')}` : `${csvs.length} arquivo(s) exportado(s), nenhuma coluna identificadora`);
  });

  // ================================================== REVOGAÇÃO PELA CONVERSA
  const G8 = ['Revogação pela conversa', 'RF02'];
  caso('T38', ...G8, 'Palavras de revogação são reconhecidas com variações de caixa e pontuação; frases comuns não', '"SAIR", " Parar! ", "Cancelar" = sim; "oi", "quero sair mais cedo" = não', async () => {
    const sim = ['SAIR', ' Parar! ', 'Cancelar', 'stop'].map((t) => engine.ehPedidoDeOptOut(t));
    const nao = ['oi', 'quero sair mais cedo', 'tem estoque?'].map((t) => engine.ehPedidoDeOptOut(t));
    return garantir(sim.every(Boolean) && !nao.some(Boolean), `reconhecidas=${sim.join(',')}; falsos positivos=${nao.filter(Boolean).length}`);
  });
  caso('T39', ...G8, 'Pedido de revogação registra opt-out com origem, torna o contato inelegível na hora e envia confirmação', 'opt_out gravado; inelegível; 1 mensagem de confirmação', async () => {
    const c = S.A[1];
    const antes = chamadasGraph.length;
    await engine.processarOptOut({ id: c.id, phone: c.telefone }, 'Sair');
    const ultima = await consent.ultimaManifestacao(c.id);
    const eleg = await consent.estaElegivel(c.id);
    const conf = chamadasGraph.slice(antes).filter((x) => x.corpo.type === 'text' && x.corpo.to === c.telefone);
    return garantir(ultima.tipo === 'opt_out' && /mensagem recebida/.test(ultima.origem) && eleg === false && conf.length === 1,
      `última manifestação=${ultima.tipo} (origem: ${ultima.origem}); elegível=${eleg}; confirmações enviadas=${conf.length}`);
  });

  // ================================================== RASTREABILIDADE DA BASE
  const G9 = ['Rastreabilidade da base', 'RF02'];
  caso('T40', ...G9, 'O banco recusa alterar um registro de consentimento', 'UPDATE recusado pelo gatilho', async () => {
    const e = await lancaErro(() => db.prepare("UPDATE consentimentos SET tipo = 'opt_in' WHERE contact_id = ?").run(S.A[2].id));
    return garantir(e, e ? `recusado: ${e.message}` : 'alteração aceita');
  });
  caso('T41', ...G9, 'O banco recusa apagar um registro de consentimento', 'DELETE recusado pelo gatilho', async () => {
    const e = await lancaErro(() => db.prepare('DELETE FROM consentimentos WHERE contact_id = ?').run(S.A[2].id));
    return garantir(e, e ? `recusado: ${e.message}` : 'exclusão aceita');
  });

  // ================================================== PLATAFORMA E CREDENCIAIS
  const G10 = ['Plataforma e credenciais', 'RNF01, RNF03'];
  caso('T42', ...G10, 'Modelo não aprovado pela Meta não pode ser disparado', 'erro; nenhuma chamada à API', async () => {
    const c = await novoContato({ perfil: `${MARCA}-pend` }); await optIn(c.id);
    const camp = await novaCampanha(await novoSegmento(`${MARCA}-pend`), await novoModelo('pendente'));
    const antes = chamadasGraph.length;
    const e = await lancaErro(() => engine.executarCampanha(camp));
    return garantir(e && chamadasGraph.length === antes, `${e ? `recusado: ${e.message}` : 'disparado'}; chamadas=${chamadasGraph.length - antes}`);
  });
  caso('T43', ...G10, 'Campanha do cenário manual não é disparada pelo motor', 'erro', async () => {
    const camp = await novaCampanha(S.segA, S.modA, 'manual');
    const e = await lancaErro(() => engine.executarCampanha(camp));
    return garantir(e, e ? `recusado: ${e.message.slice(0, 80)}...` : 'disparada');
  });
  caso('T44', ...G10, 'Envios usam apenas o endpoint oficial da Graph API, com token lido do ambiente e tipo "template"', 'URL graph.facebook.com/vXX/<phone_id>/messages; Bearer do ambiente', async () => {
    const c = S.chamadasA[0];
    const auth = c.headers.Authorization || c.headers.authorization;
    const ok = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/PHONE_ID_TESTE\/messages$/.test(c.url) &&
      auth === 'Bearer token-de-teste' && c.corpo.type === 'template' && c.corpo.messaging_product === 'whatsapp';
    return garantir(ok, `url=${c.url}; autorização do ambiente=${auth === 'Bearer token-de-teste'}; tipo=${c.corpo.type}`);
  });

  // ================================================================ DESEMPENHO
  caso('T45', 'Desempenho', 'RNF05', 'Campanha com 200 contatos elegíveis é processada sem o intervalo entre envios exigido pela plataforma', '200 envios; tempo registrado', async () => {
    const perfil = `${MARCA}-perf`;
    await db.prepare(`
      INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil)
      SELECT 'whatsapp', ? || g, 'Carga ' || g, ? || g, ? FROM generate_series(1, 200) g
    `).run(`88${MARCA.slice(-8)}`, `88${MARCA.slice(-8)}`, perfil);
    await db.prepare(`
      INSERT INTO consentimentos (contact_id, tipo, finalidade, origem)
      SELECT id, 'opt_in', 'bateria de testes', ? FROM contacts WHERE perfil = ?
    `).run(MARCA, perfil);
    const camp = await novaCampanha(await novoSegmento(perfil), await novoModelo());
    const t0 = process.hrtime.bigint();
    const r = await engine.executarCampanha(camp);
    const seg = Number(process.hrtime.bigint() - t0) / 1e9;
    S.tempoCarga = seg;
    return garantir(r.enviados === 200, `${r.enviados} envios em ${seg.toFixed(2)} s`);
  });

  // ============================================================ INTERFACE HTTP
  const G12 = ['Interface HTTP', 'RF01, RF09, RNF01, RNF02'];
  let servidor = null;
  const corpoStatus = (id, status) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id, status }] } }] }],
  });
  const assinar = (corpo) => `sha256=${crypto.createHmac('sha256', 'segredo-de-teste').update(corpo).digest('hex')}`;
  async function login(usuario, senha) {
    const r = await fetch(`${URL_HTTP}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usuario, password: senha }) });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  }

  caso('T46', ...G12, 'Verificação do webhook: token correto devolve o desafio; token incorreto é recusado', '200 com o desafio; 403', async () => {
    const env = { ...process.env, PORT: String(PORTA_HTTP), WHATSAPP_ACCESS_TOKEN: '', NODE_ENV: 'test', SESSION_SECRET: 'sessao-teste', CAMPAIGN_SCHEDULER_ENABLED: 'false' };
    servidor = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
    servidor.stdout.on('data', () => {}); servidor.stderr.on('data', () => {});
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`${URL_HTTP}/api/session`)).ok) break; } catch { /* aguardando */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const ok = await fetch(`${URL_HTTP}/webhooks/meta?hub.mode=subscribe&hub.verify_token=verifica-teste&hub.challenge=12345`);
    const txt = await ok.text();
    const ruim = await fetch(`${URL_HTTP}/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=12345`);
    return garantir(ok.status === 200 && txt === '12345' && ruim.status === 403, `token correto: ${ok.status} "${txt}"; token incorreto: ${ruim.status}`);
  });
  caso('T47', ...G12, 'Notificação sem assinatura é recusada', '401', async () => {
    const r = await fetch(`${URL_HTTP}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpoStatus('x', 'read') });
    return garantir(r.status === 401, `HTTP ${r.status}`);
  });
  caso('T48', ...G12, 'Notificação com assinatura HMAC-SHA256 inválida é recusada', '401', async () => {
    const corpo = corpoStatus('x', 'read');
    const r = await fetch(`${URL_HTTP}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }, body: corpo });
    return garantir(r.status === 401, `HTTP ${r.status}`);
  });
  caso('T49', ...G12, 'Notificação com assinatura válida é aceita e vira evento vinculado ao envio', '200; evento "lido" gravado', async () => {
    const envio = S.enviosA[1];
    const corpo = corpoStatus(envio.id_api, 'read');
    const r = await fetch(`${URL_HTTP}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': assinar(corpo) }, body: corpo });
    let ev = null;
    for (let i = 0; i < 20 && !ev; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      ev = await db.prepare('SELECT * FROM eventos_interacao WHERE id_evento_api = ?').get(`lido:${envio.id_api}`);
    }
    return garantir(r.status === 200 && ev && ev.envio_id === envio.id, `HTTP ${r.status}; evento registrado: ${Boolean(ev)}`);
  });
  caso('T50', ...G12, 'Link rastreado redireciona ao destino; token inexistente devolve 404', '302 para o destino; 404', async () => {
    const link = S.linksA[1];
    const r = await fetch(`${URL_HTTP}/r/${link.token}`, { redirect: 'manual' });
    const nf = await fetch(`${URL_HTTP}/r/inexistente${MARCA}`, { redirect: 'manual' });
    return garantir(r.status === 302 && r.headers.get('location') === 'https://exemplo.test/oferta' && nf.status === 404,
      `HTTP ${r.status} → ${r.headers.get('location')}; token inexistente: ${nf.status}`);
  });
  caso('T51', ...G12, 'API de campanhas exige sessão e perfil de administrador', 'sem sessão 401; atendente 403', async () => {
    await db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, 'Atendente teste', 'agent')").run(`agente_${MARCA}`, hashPassword('senha-teste'));
    const sem = await fetch(`${URL_HTTP}/api/campanhas`);
    const cookie = await login(`agente_${MARCA}`, 'senha-teste');
    const ag = await fetch(`${URL_HTTP}/api/campanhas`, { headers: { Cookie: cookie } });
    return garantir(sem.status === 401 && ag.status === 403, `sem sessão: ${sem.status}; atendente: ${ag.status}`);
  });
  caso('T52', ...G12, 'Administrador autenticado acessa cadastro de contatos e campanhas', '200 nas duas rotas', async () => {
    await db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, 'Admin teste', 'admin')").run(`admin_${MARCA}`, hashPassword('senha-teste'));
    const cookie = await login(`admin_${MARCA}`, 'senha-teste');
    const c = await fetch(`${URL_HTTP}/api/contatos`, { headers: { Cookie: cookie } });
    const k = await fetch(`${URL_HTTP}/api/campanhas`, { headers: { Cookie: cookie } });
    return garantir(c.status === 200 && k.status === 200, `contatos: ${c.status}; campanhas: ${k.status}`);
  });

  // ============================================================== EXECUÇÃO ====
  const inicio = new Date();
  const resultados = [];
  console.log(`\nBateria de testes — base "${BASE_TESTE}" — ${inicio.toLocaleString('pt-BR')}\n`);
  for (const c of casos) {
    let situacao = 'Aprovado'; let obtido;
    try { obtido = await c.fn(); } catch (e) { situacao = 'Reprovado'; obtido = e.obtido || `erro: ${e.message}`; }
    resultados.push({ id: c.id, grupo: c.grupo, requisitos: c.requisitos, descricao: c.descricao, esperado: c.esperado, obtido: String(obtido), situacao });
    console.log(`${situacao === 'Aprovado' ? '  OK   ' : ' FALHA '} ${c.id}  ${c.descricao}\n         → ${obtido}`);
  }
  if (servidor) servidor.kill();

  // --------------------------------------------------------- resumo por grupo
  const grupos = [];
  for (const r of resultados) {
    let g = grupos.find((x) => x.grupo === r.grupo);
    if (!g) grupos.push(g = { grupo: r.grupo, requisitos: r.requisitos, casos: 0, aprovados: 0, reprovados: 0 });
    g.casos += 1; if (r.situacao === 'Aprovado') g.aprovados += 1; else g.reprovados += 1;
  }
  const total = { casos: resultados.length, aprovados: resultados.filter((r) => r.situacao === 'Aprovado').length };
  total.reprovados = total.casos - total.aprovados;
  console.log('\nResumo por grupo (Tabela 4)\n');
  console.log('Grupo'.padEnd(32) + 'Casos  Aprov.  Reprov.');
  for (const g of grupos) console.log(g.grupo.padEnd(32) + String(g.casos).padStart(5) + String(g.aprovados).padStart(8) + String(g.reprovados).padStart(9));
  console.log('Total'.padEnd(32) + String(total.casos).padStart(5) + String(total.aprovados).padStart(8) + String(total.reprovados).padStart(9));

  // ----------------------------------------------------- checklist LGPD (31)
  const st = (...ids) => ({ tipo: 'teste', ids });
  const insp = (comoVerificar) => ({ tipo: 'inspecao', comoVerificar });
  const CHECKLIST = [
    ['A. Base legal e consentimento (arts. 7º e 8º)', [
      ['A1', 'Campanha só é enviada a contato com opt-in vigente', 'art. 7º, I', st('T17', 'T19')],
      ['A2', 'Cada manifestação registra data e hora', 'art. 8º, §2º', st('T01')],
      ['A3', 'Cada manifestação registra a finalidade', 'art. 8º, §4º', st('T01')],
      ['A4', 'Cada manifestação registra a origem; registro sem origem é recusado', 'art. 8º, §2º', st('T01', 'T03')],
      ['A5', 'Ausência de registro não é tratada como consentimento presumido', 'art. 8º', st('T04')],
      ['A6', 'Consentimento também é verificado no envio manual', 'art. 7º, I', st('T09')],
    ]],
    ['B. Revogação (art. 8º, §5º)', [
      ['B1', 'Revogação pela própria conversa, por palavra-chave', 'art. 8º, §5º', st('T38', 'T39')],
      ['B2', 'Revogação tem efeito imediato sobre a elegibilidade', 'art. 8º, §5º', st('T06', 'T39')],
      ['B3', 'Revogação gratuita e confirmada ao titular', 'art. 8º, §5º', st('T39')],
      ['B4', 'Revogação tem precedência sobre o robô de conversa', 'art. 8º, §5º', insp('Bateria do robô (npm run test:chatbot), grupo "Precedência do opt-out"')],
      ['B5', 'Titular pode consentir novamente após revogar', 'art. 8º, §5º', st('T07')],
    ]],
    ['C. Integridade e auditabilidade (art. 37)', [
      ['C1', 'Histórico de consentimento não pode ser alterado nem apagado', 'art. 37', st('T40', 'T41')],
      ['C2', 'Cada execução de campanha gera registro com início, fim e resultado', 'art. 37', st('T22')],
      ['C3', 'Métricas conferem com recontagem a partir dos eventos brutos', 'art. 37', st('T33')],
    ]],
    ['D. Minimização e finalidade (art. 6º, I e III)', [
      ['D1', 'Cadastro sem dados além dos necessários', 'art. 6º, III', st('T34')],
      ['D2', 'Ao provedor do modelo de linguagem só vão o texto recente e campos públicos dos produtos', 'art. 6º, III', insp('Bateria do robô (npm run test:chatbot), grupo "Uso do modelo de linguagem"')],
      ['D3', 'Dados exportados para análise não identificam o titular', 'art. 6º, III; art. 12', st('T37')],
    ]],
    ['E. Segurança (art. 46)', [
      ['E1', 'Autenticidade das notificações por assinatura HMAC-SHA256', 'art. 46', st('T47', 'T48', 'T49')],
      ['E2', 'Credenciais fora do código e do versionamento', 'art. 46', st('T36')],
      ['E3', 'Painel e API exigem autenticação', 'art. 46', st('T51')],
      ['E4', 'Operações de campanha restritas a administradores', 'art. 46', st('T51', 'T52')],
      ['E5', 'Segmentação protegida contra injeção de SQL', 'art. 46', st('T12')],
      ['E6', 'Senhas armazenadas com hash e salt (scrypt) e comparação em tempo constante', 'art. 46', insp('Inspeção de src/utils/password.js')],
      ['E7', 'Servidor exposto apenas por túnel com TLS, sem porta de entrada aberta', 'art. 46', insp('Inspeção da configuração do Cloudflare Tunnel e do roteador')],
    ]],
    ['F. Direitos do titular (art. 18)', [
      ['F1', 'Operador consegue consultar o histórico de consentimento de um titular', 'art. 18, I e II', insp('Inspeção da tela de histórico de consentimento (Figura 13)')],
      ['F2', 'Contato pode ser anonimizado', 'art. 18, IV', st('T35')],
      ['F3', 'Contato anonimizado não recebe novos envios', 'art. 18, IV', st('T35')],
      ['F4', 'Eliminação e portabilidade a pedido do titular', 'art. 18, V e VI', insp('Verificar se há procedimento; se não houver, registrar como não implementado')],
    ]],
    ['G. Conformidade com a plataforma', [
      ['G1', 'Mensagens proativas só por modelo aprovado pela Meta', 'Política do WhatsApp Business', st('T42')],
      ['G2', 'Comunicação exclusivamente pela API oficial', 'Política do WhatsApp Business', st('T44')],
      ['G3', 'Texto livre só dentro da janela de 24 h', 'Política do WhatsApp Business', insp('Regra imposta pela Cloud API (o sistema não bloqueia antes); verificar nos registros de erro')],
    ]],
  ];
  const porId = Object.fromEntries(resultados.map((r) => [r.id, r]));
  const checklist = CHECKLIST.map(([grupo, itens]) => ({
    grupo,
    itens: itens.map(([id, criterio, base, ver]) => {
      let situacao; let forma;
      if (ver.tipo === 'teste') {
        const ok = ver.ids.every((t) => porId[t] && porId[t].situacao === 'Aprovado');
        situacao = ok ? 'Atendido' : 'Não atendido';
        forma = `Teste ${ver.ids.join(', ')}`;
      } else { situacao = 'Inspeção (preencher)'; forma = ver.comoVerificar; }
      return { id, criterio, base, forma, situacao };
    }),
  }));
  const nItens = checklist.reduce((n, g) => n + g.itens.length, 0);
  console.log(`\nChecklist LGPD: ${nItens} critérios — ` +
    ['Atendido', 'Não atendido', 'Inspeção (preencher)'].map((s) => `${s}: ${checklist.flatMap((g) => g.itens).filter((i) => i.situacao === s).length}`).join('; '));

  // ------------------------------------------------------------ arquivos -----
  const pasta = path.join(RAIZ, 'testes', 'resultados');
  fs.mkdirSync(pasta, { recursive: true });
  const dia = inicio.toISOString().slice(0, 10);
  const versaoPg = (await db.prepare('SELECT version() AS v').get()).v.split(',')[0];
  fs.writeFileSync(path.join(pasta, `bateria-${dia}.json`), JSON.stringify({
    executado_em: inicio.toISOString(), base: BASE_TESTE, node: process.version, postgres: versaoPg,
    total, grupos, casos: resultados, checklist_lgpd: checklist, chamadas_graph_interceptadas: chamadasGraph.length,
  }, null, 2));

  const tex = (s) => String(s)
    .replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')
    .replace(/→/g, '$\\rightarrow$').replace(/≥/g, '$\\geq$')
    .replace(/([/=,.])(?=\S)/g, '$1\\allowbreak{}'); // permite quebrar URLs e listas longas
  const dataBr = inicio.toLocaleDateString('pt-BR');

  const linhasCasos = [];
  for (const g of grupos) {
    linhasCasos.push(`\\multicolumn{5}{l}{\\textbf{${tex(g.grupo)}} (${tex(g.requisitos)})} \\\\ \\hline`);
    for (const r of resultados.filter((x) => x.grupo === g.grupo)) {
      linhasCasos.push(`${r.id} & ${tex(r.descricao)} & ${tex(r.esperado)} & ${tex(r.obtido)} & ${r.situacao === 'Aprovado' ? 'Aprov.' : '\\textbf{Reprov.}'} \\\\ \\hline`);
    }
  }
  fs.writeFileSync(path.join(pasta, 'apendice-casos-de-teste.tex'), `% Gerado automaticamente por scripts/bateria-testes.js em ${inicio.toISOString()}
% Requer no preâmbulo: \\usepackage{longtable} e \\usepackage{array}
\\chapter{Casos de teste do protótipo}
\\label{ap:casos-teste}

Este apêndice lista os ${total.casos} casos de teste executados pela bateria automatizada (\\texttt{npm run test:bateria}) em ${dataBr}, sobre uma base PostgreSQL de teste separada da base da empresa (${tex(versaoPg)}; Node.js ${process.version}). As chamadas à Cloud API foram interceptadas, de modo que nenhuma mensagem foi enviada; os casos de interface HTTP foram executados contra uma instância do servidor em funcionamento. Resultado: ${total.aprovados} casos aprovados e ${total.reprovados} reprovados.

{\\footnotesize
\\begin{longtable}{|p{0.6cm}|>{\\raggedright\\arraybackslash}p{4.6cm}|>{\\raggedright\\arraybackslash}p{2.9cm}|>{\\raggedright\\arraybackslash}p{4.4cm}|p{1.1cm}|}
\\caption{Casos de teste e resultados obtidos} \\label{tab:casos-teste} \\\\ \\hline
\\textbf{ID} & \\textbf{Caso} & \\textbf{Esperado} & \\textbf{Obtido} & \\textbf{Sit.} \\\\ \\hline
\\endfirsthead
\\hline \\textbf{ID} & \\textbf{Caso} & \\textbf{Esperado} & \\textbf{Obtido} & \\textbf{Sit.} \\\\ \\hline
\\endhead
${linhasCasos.join('\n')}
\\end{longtable}
}
\\fonte{Elaborado pelo autor (${inicio.getFullYear()}).}
`);

  const linhasCheck = [];
  for (const g of checklist) {
    linhasCheck.push(`\\multicolumn{5}{l}{\\textbf{${tex(g.grupo)}}} \\\\ \\hline`);
    for (const i of g.itens) linhasCheck.push(`${i.id} & ${tex(i.criterio)} & ${tex(i.base)} & ${tex(i.forma)} & ${tex(i.situacao)} \\\\ \\hline`);
  }
  fs.writeFileSync(path.join(pasta, 'apendice-checklist-lgpd.tex'), `% Gerado automaticamente por scripts/bateria-testes.js em ${inicio.toISOString()}
% Os itens "Inspeção (preencher)" devem ser verificados e preenchidos pelo autor.
% Requer no preâmbulo: \\usepackage{longtable} e \\usepackage{array}
\\chapter{Checklist de conformidade com a LGPD}
\\label{ap:checklist-lgpd}

Os ${nItens} critérios abaixo foram derivados da Lei nº 13.709/2018 e das regras da plataforma. Os critérios verificados por teste referem-se aos casos do Apêndice~\\ref{ap:casos-teste}, executados em ${dataBr}.

{\\footnotesize
\\begin{longtable}{|p{0.6cm}|>{\\raggedright\\arraybackslash}p{5.2cm}|>{\\raggedright\\arraybackslash}p{2.0cm}|>{\\raggedright\\arraybackslash}p{4.0cm}|>{\\raggedright\\arraybackslash}p{1.8cm}|}
\\caption{Checklist de conformidade com a LGPD} \\label{tab:checklist-lgpd} \\\\ \\hline
\\textbf{ID} & \\textbf{Critério} & \\textbf{Base} & \\textbf{Verificação} & \\textbf{Situação} \\\\ \\hline
\\endfirsthead
\\hline \\textbf{ID} & \\textbf{Critério} & \\textbf{Base} & \\textbf{Verificação} & \\textbf{Situação} \\\\ \\hline
\\endhead
${linhasCheck.join('\n')}
\\end{longtable}
}
\\fonte{Elaborado pelo autor (${inicio.getFullYear()}).}
`);

  console.log(`\nArquivos gerados em ${path.relative(process.cwd(), pasta) || pasta}:`);
  console.log(`  bateria-${dia}.json\n  apendice-casos-de-teste.tex\n  apendice-checklist-lgpd.tex\n`);
  await db.close();
  process.exit(total.reprovados ? 1 : 0);
})().catch((e) => {
  console.error('ERRO NA BATERIA:', e);
  process.exit(2);
});
