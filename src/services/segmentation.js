const { stmt } = require('../db/stmt');
const { SQL_ELEGIVEL } = require('./consent');

// RF03 / RF06 — Segmento.resolver()
// Regras determinísticas definidas pelo operador, combinadas por conjunção (AND).
// A lista de destinatários de uma campanha só é produzida aqui, e é aqui que a
// verificação de consentimento se aplica: nenhum contato inelegível chega ao envio.

// Lista branca de atributos — evita injeção e mantém o modelo lógico explícito.
const ATRIBUTOS = {
  perfil: 'contacts.perfil',
  interesse_declarado: 'contacts.interesse_declarado',
  nivel_engajamento: 'contacts.nivel_engajamento',
  ultima_interacao: 'contacts.ultima_interacao',
  display_name: 'contacts.display_name',
  phone: 'contacts.phone',
  platform: 'contacts.platform',
  created_at: 'contacts.created_at',
};

// "câmeras, lentes" → ['câmeras', 'lentes']
function itens(valor) {
  return String(valor ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}
function itemNaLista(col, comparacao) {
  return `(', ' || lower(COALESCE(${col}, '')) || ',') ${comparacao} ('%, ' || lower(?) || ',%')`;
}

const OPERADORES = {
  igual: (col) => ({ sql: `COALESCE(${col}, '') = ?`, usaValor: true }),
  diferente: (col) => ({ sql: `COALESCE(${col}, '') <> ?`, usaValor: true }),
  contem: (col) => ({ sql: `COALESCE(${col}, '') LIKE '%' || ? || '%'`, usaValor: true }),
  comeca_com: (col) => ({ sql: `COALESCE(${col}, '') LIKE ? || '%'`, usaValor: true }),
  maior_que: (col) => ({ sql: `CAST(${col} AS REAL) > CAST(? AS REAL)`, usaValor: true }),
  menor_que: (col) => ({ sql: `CAST(${col} AS REAL) < CAST(? AS REAL)`, usaValor: true }),
  nos_ultimos_dias: (col) => ({
    sql: `${col} IS NOT NULL AND ${col} >= (now() - (CAST(? AS INTEGER) * interval '1 day'))`,
    usaValor: true,
  }),
  sem_interacao_ha_dias: (col) => ({
    sql: `(${col} IS NULL OR ${col} < (now() - (CAST(? AS INTEGER) * interval '1 day')))`,
    usaValor: true,
  }),
  // Listas separadas por vírgula ("câmeras, iPhone"): item exato, sem diferenciar
  // maiúsculas. "possui iPhone" não pega "iPhone usado" (o "contem" pegaria).
  possui: (col) => ({
    sql: `(', ' || lower(COALESCE(${col}, '')) || ',') LIKE ('%, ' || lower(trim(?)) || ',%')`,
    usaValor: true,
  }),
  nao_possui: (col) => ({
    sql: `(', ' || lower(COALESCE(${col}, '')) || ',') NOT LIKE ('%, ' || lower(trim(?)) || ',%')`,
    usaValor: true,
  }),
  // Vários valores numa regra só ("câmeras, lentes"), usados pelo editor em frases:
  // "tem interesse em câmeras OU lentes", "não tem interesse em nenhum de",
  // "engajamento alto OU médio".
  possui_algum: (col, valor) => {
    const lista = itens(valor);
    if (!lista.length) return { sql: 'FALSE', params: [] };
    return { sql: lista.map(() => itemNaLista(col, 'LIKE')).join(' OR '), params: lista };
  },
  nao_possui_nenhum: (col, valor) => {
    const lista = itens(valor);
    if (!lista.length) return { sql: 'TRUE', params: [] };
    return { sql: lista.map(() => itemNaLista(col, 'NOT LIKE')).join(' AND '), params: lista };
  },
  em: (col, valor) => {
    const lista = itens(valor);
    if (!lista.length) return { sql: 'FALSE', params: [] };
    return { sql: `lower(COALESCE(${col}, '')) IN (${lista.map(() => 'lower(?)').join(', ')})`, params: lista };
  },
  preenchido: (col) => ({ sql: `COALESCE(${col}, '') <> ''`, usaValor: false }),
  vazio: (col) => ({ sql: `COALESCE(${col}, '') = ''`, usaValor: false }),
};

function listarOperadores() {
  return Object.keys(OPERADORES);
}

function listarAtributos() {
  return Object.keys(ATRIBUTOS);
}

function validarRegra(regra) {
  if (!ATRIBUTOS[regra.atributo]) {
    throw new Error(`Atributo de segmentação inválido: ${regra.atributo}`);
  }
  if (!OPERADORES[regra.operador]) {
    throw new Error(`Operador de segmentação inválido: ${regra.operador}`);
  }
  return true;
}

async function regrasDoSegmento(segmentoId) {
  return await stmt(`
    SELECT * FROM regras_segmentacao WHERE segmento_id = ? ORDER BY ordem, id
  `).all(segmentoId);
}

// RegraSegmentacao.avaliar(contato) traduzida para uma única consulta.
function montarClausula(regras) {
  const condicoes = [];
  const params = [];

  for (const regra of regras) {
    validarRegra(regra);
    const coluna = ATRIBUTOS[regra.atributo];
    const r = OPERADORES[regra.operador](coluna, regra.valor_referencia);
    condicoes.push(`(${r.sql})`);
    if (r.params) params.push(...r.params);
    else if (r.usaValor) params.push(regra.valor_referencia);
  }

  return { where: condicoes.length ? condicoes.join(' AND ') : '1 = 1', params };
}

/**
 * Resolve os contatos de um segmento.
 * @param {number} segmentoId
 * @param {{somenteElegiveis?: boolean, plataforma?: string}} opcoes
 */
async function resolver(segmentoId, opcoes = {}) {
  return resolverRegras(await regrasDoSegmento(segmentoId), opcoes);
}

// Mesmo cálculo a partir de regras ainda não salvas (prévia ao vivo no editor).
async function resolverRegras(regras, opcoes = {}) {
  const { where, params } = montarClausula(regras || []);

  const filtros = [where];
  const valores = [...params];

  filtros.push('contacts.anonimizado = 0');

  if (opcoes.plataforma) {
    filtros.push('contacts.platform = ?');
    valores.push(opcoes.plataforma);
  }
  if (opcoes.somenteElegiveis) {
    filtros.push(SQL_ELEGIVEL);
  }

  return await stmt(`
    SELECT contacts.*, ${SQL_ELEGIVEL} AS elegivel
    FROM contacts
    WHERE ${filtros.join(' AND ')}
    ORDER BY contacts.id
  `).all(...valores);
}

// Prévia usada na tela de segmentos antes de criar a campanha.
async function previa(segmentoId) {
  return resumoPrevia(await resolver(segmentoId));
}

async function previaRegras(regras) {
  return resumoPrevia(await resolverRegras(regras));
}

function resumoPrevia(todos) {
  const elegiveis = todos.filter((c) => c.elegivel === 1 || c.elegivel === true);
  return {
    total: todos.length,
    elegiveis: elegiveis.length,
    inelegiveis: todos.length - elegiveis.length,
    amostra: todos.slice(0, 10).map((c) => ({
      id: c.id,
      display_name: c.display_name,
      phone: c.phone,
      perfil: c.perfil,
      nivel_engajamento: c.nivel_engajamento,
      interesse_declarado: c.interesse_declarado,
      elegivel: Boolean(c.elegivel),
    })),
  };
}

module.exports = {
  ATRIBUTOS,
  resolver,
  resolverRegras,
  previa,
  previaRegras,
  regrasDoSegmento,
  validarRegra,
  listarOperadores,
  listarAtributos,
};
