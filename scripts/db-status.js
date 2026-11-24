(async () => {
require('dotenv').config();
const db = require('../src/db');

// Panorama do banco: o que existe, se a integridade está íntegra e se a base
// está pronta para uma campanha. Uso: npm run db:status

const TABELAS = [
  ['users', 'usuários'],
  ['contacts', 'contatos'],
  ['conversations', 'conversas'],
  ['messages', 'mensagens'],
  ['notes', 'anotações'],
  ['tags', 'etiquetas'],
  ['conversation_tags', 'etiquetas aplicadas'],
  ['products', 'produtos'],
  ['flows', 'fluxos do chatbot'],
  ['flow_runs', 'execuções de fluxo'],
  ['flow_run_events', 'eventos de fluxo'],
  ['consentimentos', 'manifestações de consentimento'],
  ['segmentos', 'segmentos'],
  ['regras_segmentacao', 'regras de segmentação'],
  ['modelos_mensagem', 'modelos de mensagem'],
  ['campanhas', 'campanhas'],
  ['envios', 'envios'],
  ['links_rastreados', 'links rastreados'],
  ['eventos_interacao', 'eventos de interação'],
  ['conversoes', 'conversões'],
  ['metricas_campanha', 'métricas consolidadas'],
  ['registros_execucao_fluxo', 'registros de execução'],
];

async function conta(tabela) {
  try {
    return ((await db.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get())).t;
  } catch {
    return '— ausente —';
  }
}

const versao = await db.prepare('SELECT version() AS v').get();
console.log(`\n${String(versao.v).split(',')[0]}`);
console.log('\n=== TABELAS ===');
for (const [tabela, rotulo] of TABELAS) {
  console.log(`${String(await conta(tabela)).padStart(8)}  ${tabela.padEnd(26)} ${rotulo}`);
}

const SQL_VIEWS =
  "SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1";
const SQL_TRIGGERS =
  "SELECT DISTINCT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY 1";

const views = (await db.prepare(SQL_VIEWS).all()).map((v) => v.name);
console.log(`\n=== VISÕES (${views.length}) ===\n${views.join('\n')}`);

const triggers = (await db.prepare(SQL_TRIGGERS).all()).map((t) => t.name);
console.log(`\n=== GATILHOS (${triggers.length}) ===\n${triggers.join('\n')}`);

console.log('\n=== BASE DE CONTATOS ===');
try {
  console.table(await db.prepare('SELECT * FROM vw_base_contatos').all());
} catch (err) {
  console.log('visão indisponível:', err.message);
}

console.log('=== CAMPANHAS ===');
try {
  const linhas = await db
    .prepare(`
      SELECT campanha, cenario, situacao, enviados, bloqueados_sem_consentimento AS bloqueados,
             respostas, cliques, conversoes, taxa_resposta, tempo_medio_resposta_seg AS tempo_seg
      FROM vw_campanha_desempenho ORDER BY campanha_id
    `)
    .all();
  if (linhas.length) console.table(linhas);
  else console.log('(nenhuma campanha cadastrada)\n');
} catch (err) {
  console.log('visão indisponível:', err.message);
}

console.log('=== INTEGRIDADE ===');
const inval = await db.prepare(
  "SELECT COUNT(*) AS t FROM pg_constraint WHERE contype = 'f' AND NOT convalidated"
).get();
console.log(inval.t ? `${inval.t} chave(s) estrangeira(s) nao validada(s)!` : 'chaves estrangeiras: ok');
const tamanho = await db.prepare("SELECT pg_size_pretty(pg_database_size(current_database())) AS s").get();
console.log('tamanho do banco:', tamanho.s);

// Pendências que impedem uma campanha de rodar de verdade.
console.log('\n=== PRONTIDÃO PARA CAMPANHA ===');
const avisos = [];
const elegiveis = ((await db.prepare('SELECT elegiveis FROM vw_base_contatos').get())).elegiveis || 0;
if (elegiveis < 15) {
  avisos.push(`apenas ${elegiveis} contato(s) elegível(is) — o grupo piloto do TCC prevê no mínimo 15`);
}
const aprovados = (await db
  .prepare("SELECT COUNT(*) AS t FROM modelos_mensagem WHERE situacao_aprovacao = 'aprovado'")
  .get()).t;
if (!aprovados) avisos.push('nenhum modelo de mensagem aprovado — o motor recusa o disparo');
if (!((await db.prepare('SELECT COUNT(*) AS t FROM regras_segmentacao').get())).t) {
  avisos.push('nenhuma regra de segmentação cadastrada');
}
if (!process.env.WHATSAPP_ACCESS_TOKEN) avisos.push('WHATSAPP_ACCESS_TOKEN vazio — envio será simulado');
if (!process.env.PGDATABASE && !process.env.DATABASE_URL) avisos.push('PGDATABASE/DATABASE_URL nao configurado no .env');
if (!process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL.includes('localhost')) {
  avisos.push('PUBLIC_BASE_URL ausente ou em localhost — a taxa de clique ficará zerada');
}
console.log(avisos.length ? avisos.map((a) => `  • ${a}`).join('\n') : '  tudo pronto.');
console.log();

await db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
