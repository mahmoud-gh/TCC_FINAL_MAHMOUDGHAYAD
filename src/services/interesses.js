const db = require('../db');
const { stmt } = require('../db/stmt');

// ===========================================================================
//  Interesses dos contatos (catálogo próprio + marcação por contato).
//
//  - interesses: a lista que o lojista cria ("câmeras", "iPhone", "drones"...)
//  - contato_interesses: quais interesses cada contato tem
//  - contacts.interesse_declarado continua existindo como texto ("câmeras, iPhone"),
//    sempre gerado a partir das tabelas acima. Assim a segmentação, os modelos
//    de mensagem ({{interesse_declarado}}) e as visões não mudam.
// ===========================================================================

let esquemaPronto = null;
function garantirEsquema() {
  if (!esquemaPronto) {
    esquemaPronto = (async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS interesses (
          id         SERIAL PRIMARY KEY,
          nome       TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_interesses_nome ON interesses (lower(nome));
        CREATE TABLE IF NOT EXISTS contato_interesses (
          contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          interesse_id INTEGER NOT NULL REFERENCES interesses(id) ON DELETE CASCADE,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (contact_id, interesse_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contato_interesses_interesse ON contato_interesses (interesse_id);
      `);
      // Primeira vez: o texto que já existia ("câmeras, iPhone") vira interesses do catálogo.
      const antigos = await stmt(`
        SELECT c.id, c.interesse_declarado FROM contacts c
        WHERE COALESCE(c.interesse_declarado, '') <> ''
          AND NOT EXISTS (SELECT 1 FROM contato_interesses ci WHERE ci.contact_id = c.id)
      `).all();
      for (const c of antigos) await _definirPorTexto(c.id, c.interesse_declarado);
    })().catch((err) => { esquemaPronto = null; throw err; });
  }
  return esquemaPronto;
}

// Vírgula e ponto e vírgula separam interesses no texto; não podem fazer parte do nome.
function normalizarNome(nome) {
  return String(nome || '').replace(/[,;|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

async function listar() {
  await garantirEsquema();
  return stmt(`
    SELECT i.id, i.nome, i.created_at, COUNT(ci.contact_id)::int AS total
    FROM interesses i
    LEFT JOIN contato_interesses ci ON ci.interesse_id = i.id
    GROUP BY i.id
    ORDER BY lower(i.nome)
  `).all();
}

async function porNome(nome) {
  return stmt('SELECT id, nome FROM interesses WHERE lower(nome) = lower(?)').get(nome);
}

// Cria o interesse (ou devolve o que já existe com o mesmo nome, sem diferenciar maiúsculas).
// As funções com "_" não esperam o esquema: são usadas também pela importação inicial.
async function _criar(nomeBruto) {
  const nome = normalizarNome(nomeBruto);
  if (!nome) throw new Error('Informe o nome do interesse.');
  const existente = await porNome(nome);
  if (existente) return { ...existente, criado: false };
  await stmt('INSERT INTO interesses (nome) VALUES (?) ON CONFLICT DO NOTHING').run(nome);
  return { ...(await porNome(nome)), criado: true };
}

async function contatosDoInteresse(id) {
  return (await stmt('SELECT contact_id FROM contato_interesses WHERE interesse_id = ?').all(id))
    .map((r) => r.contact_id);
}

async function renomear(id, nomeBruto) {
  await garantirEsquema();
  const nome = normalizarNome(nomeBruto);
  if (!nome) throw new Error('Informe o nome do interesse.');
  const outro = await porNome(nome);
  if (outro && outro.id !== Number(id)) throw new Error(`Já existe o interesse "${outro.nome}".`);
  const r = await stmt('UPDATE interesses SET nome = ? WHERE id = ?').run(nome, id);
  if (!r.changes) throw new Error('Interesse não encontrado.');
  await sincronizar(await contatosDoInteresse(id));
  return { id: Number(id), nome };
}

// Remove do catálogo e de todos os contatos que o tinham.
async function excluir(id) {
  await garantirEsquema();
  const afetados = await contatosDoInteresse(id);
  const r = await stmt('DELETE FROM interesses WHERE id = ?').run(id);
  if (!r.changes) throw new Error('Interesse não encontrado.');
  await sincronizar(afetados);
  return { removidoDe: afetados.length };
}

async function _doContato(contactId) {
  return stmt(`
    SELECT i.id, i.nome FROM contato_interesses ci
    JOIN interesses i ON i.id = ci.interesse_id
    WHERE ci.contact_id = ?
    ORDER BY lower(i.nome)
  `).all(contactId);
}

// Define exatamente quais interesses o contato tem (marca os novos, desmarca os que saíram).
async function _definirDoContato(contactId, ids) {
  const desejados = new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const atuais = new Set((await _doContato(contactId)).map((i) => i.id));
  for (const id of atuais) {
    if (!desejados.has(id)) {
      await stmt('DELETE FROM contato_interesses WHERE contact_id = ? AND interesse_id = ?').run(contactId, id);
    }
  }
  for (const id of desejados) {
    if (!atuais.has(id)) {
      await stmt(`
        INSERT INTO contato_interesses (contact_id, interesse_id)
        SELECT ?, id FROM interesses WHERE id = ?
        ON CONFLICT DO NOTHING
      `).run(contactId, id);
    }
  }
  await sincronizar([contactId]);
  return _doContato(contactId);
}

// Texto livre ("câmeras, iPhone; drones") → interesses do catálogo (cria os que faltam).
async function _definirPorTexto(contactId, texto) {
  const nomes = String(texto || '').split(/[,;|]/).map(normalizarNome).filter(Boolean);
  const ids = [];
  for (const nome of nomes) ids.push((await _criar(nome)).id);
  return _definirDoContato(contactId, ids);
}

// Versões públicas: garantem as tabelas antes.
const comEsquema = (fn) => async (...args) => { await garantirEsquema(); return fn(...args); };
const criar = comEsquema(_criar);
const doContato = comEsquema(_doContato);
const definirDoContato = comEsquema(_definirDoContato);
const definirPorTexto = comEsquema(_definirPorTexto);

// Regrava contacts.interesse_declarado a partir das marcações.
async function sincronizar(contactIds) {
  for (const id of new Set(contactIds)) {
    await stmt(`
      UPDATE contacts SET interesse_declarado = (
        SELECT string_agg(i.nome, ', ' ORDER BY lower(i.nome))
        FROM contato_interesses ci JOIN interesses i ON i.id = ci.interesse_id
        WHERE ci.contact_id = contacts.id
      ), updated_at = now()
      WHERE id = ?
    `).run(id);
  }
}

module.exports = {
  garantirEsquema, normalizarNome, listar, criar, renomear, excluir, doContato, definirDoContato, definirPorTexto,
};
