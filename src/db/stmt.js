const db = require('./index');

// Os módulos originais preparam statements no topo do arquivo, o que quebra o
// boot se a tabela ainda não existe. Aqui a preparação é preguiçosa e cacheada:
// mesmo custo em regime, sem acoplar o require à ordem da migração.
const cache = new Map();

function stmt(sql) {
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

module.exports = { stmt };
