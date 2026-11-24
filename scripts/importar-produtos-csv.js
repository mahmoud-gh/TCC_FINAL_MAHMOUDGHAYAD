require('dotenv').config();
const fs = require('node:fs');
const db = require('../src/db');

// ===========================================================================
//  Importa (ou atualiza) produtos a partir de uma planilha CSV — para o
//  chatbot consultar estoque quando o catálogo não vem da sincronização.
//
//  Colunas (cabeçalho obrigatório; separador ; ou ,):
//    codigo;nome;preco;preco_atacado;estoque;categoria;marca
//  Só "codigo" e "nome" são obrigatórios. Decimais com vírgula ou ponto.
//  O mesmo código importado de novo ATUALIZA preço e estoque.
//
//  Uso:  node scripts/importar-produtos-csv.js caminho/produtos.csv
//        (no Excel: Salvar como → CSV UTF-8)
// ===========================================================================

const arquivo = process.argv[2];
if (!arquivo) {
  console.error('Uso: node scripts/importar-produtos-csv.js produtos.csv');
  process.exit(1);
}

const numero = (v) => {
  if (v == null || String(v).trim() === '') return null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

(async () => {
  const texto = fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  const sep = linhas[0].includes(';') ? ';' : ',';
  const cab = linhas[0].split(sep).map((c) => c.trim().toLowerCase());
  const col = (nome) => cab.indexOf(nome);
  if (col('codigo') < 0 || col('nome') < 0) {
    console.error('O cabeçalho precisa ter pelo menos as colunas "codigo" e "nome".');
    process.exit(1);
  }

  let criados = 0;
  let atualizados = 0;
  for (const linha of linhas.slice(1)) {
    const v = linha.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const get = (nome) => (col(nome) >= 0 ? v[col(nome)] : null);
    const codigo = get('codigo');
    const nome = get('nome');
    if (!codigo || !nome) continue;
    const dados = [nome, numero(get('preco')), numero(get('preco_atacado')),
      Math.round(numero(get('estoque')) || 0), get('categoria') || null, get('marca') || null];

    const existe = await db.prepare('SELECT id FROM products WHERE codigo = ?').get(codigo);
    if (existe) {
      await db.prepare(`UPDATE products SET name = ?, price = ?, wholesale_price = ?, stock = ?,
        category_name = ?, brand_name = ?, active = 1, synced_at = now() WHERE id = ?`).run(...dados, existe.id);
      atualizados += 1;
    } else {
      const { proximo } = await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS proximo FROM products').get();
      await db.prepare(`INSERT INTO products (id, codigo, name, price, wholesale_price, stock, category_name, brand_name, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(proximo, codigo, ...dados);
      criados += 1;
    }
  }
  console.log(`Produtos criados: ${criados} | atualizados: ${atualizados}`);
  await db.close();
})().catch(async (err) => {
  console.error('Erro na importação:', err.message);
  process.exit(1);
});
