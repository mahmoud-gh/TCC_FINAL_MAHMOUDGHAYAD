// Acesso ao banco — PostgreSQL.
//
// Configuração por variáveis de ambiente (.env):
//   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
//   ou, alternativamente, DATABASE_URL
//
// Uso em rotas e serviços:
//   const linha  = await db.prepare('SELECT ... WHERE id = ?').get(id);
//   const linhas = await db.prepare('SELECT ...').all();
//   const r      = await db.prepare('INSERT ...').run(a, b);  // r.lastInsertRowid
//
// Os marcadores são `?` e a numeração para $1, $2... é feita pelo driver, que
// também acrescenta RETURNING aos INSERT para devolver a chave gerada.

const { Pool, types } = require('pg');

// Datas como texto 'YYYY-MM-DD HH:MM:SS' em UTC e números como number:
// mantém o formato que as rotas e o front-end já consomem.
const normalizarData = (valor) => (valor ? String(valor).replace('T', ' ').slice(0, 19) : valor);
types.setTypeParser(1114, normalizarData);                                   // timestamp
types.setTypeParser(1184, (v) => normalizarData(new Date(v).toISOString())); // timestamptz
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));       // numeric
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));             // int8

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'crm',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'crm',
  max: Number(process.env.PGPOOL_MAX || 10),
  options: '-c timezone=UTC',
});

// Converte os marcadores ? em $1, $2..., ignorando os que estão dentro de aspas.
function numerarParametros(sql) {
  let resultado = '';
  let indice = 0;
  let aspaSimples = false;
  let aspaDupla = false;

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'" && !aspaDupla) aspaSimples = !aspaSimples;
    else if (c === '"' && !aspaSimples) aspaDupla = !aspaDupla;

    if (c === '?' && !aspaSimples && !aspaDupla) {
      indice += 1;
      resultado += `$${indice}`;
    } else {
      resultado += c;
    }
  }
  return resultado;
}

const cache = new Map();

function compilar(sqlOriginal) {
  let compilado = cache.get(sqlOriginal);
  if (compilado) return compilado;

  let sql = sqlOriginal.trim();
  // RETURNING * permite devolver a chave gerada em qualquer tabela.
  if (/^\s*INSERT\s+INTO/i.test(sql) && !/RETURNING/i.test(sql)) sql += ' RETURNING *';

  compilado = numerarParametros(sql);
  cache.set(sqlOriginal, compilado);
  return compilado;
}

const normalizarParams = (params) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

async function executar(sql, params) {
  return pool.query(compilar(sql), normalizarParams(params));
}

module.exports = {
  prepare(sql) {
    return {
      async get(...params) { return (await executar(sql, params)).rows[0]; },
      async all(...params) { return (await executar(sql, params)).rows; },
      async run(...params) {
        const r = await executar(sql, params);
        const linha = r.rows && r.rows[0];
        return {
          changes: r.rowCount,
          lastInsertRowid: linha && linha.id != null ? Number(linha.id) : null,
        };
      },
    };
  },
  async exec(sql) { await pool.query(sql); },
  async get(sql, ...p) { return this.prepare(sql).get(...p); },
  async all(sql, ...p) { return this.prepare(sql).all(...p); },
  async run(sql, ...p) { return this.prepare(sql).run(...p); },
  async close() { await pool.end(); },
};
