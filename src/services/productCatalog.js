const db = require('../db');
const logger = require('../utils/logger');

const PER_PAGE = 100;
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas

const upsertStmt = db.prepare(`
  INSERT INTO products (id, codigo, name, price, wholesale_price, stock, category_name, brand_name, description, image_url, active, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
  ON CONFLICT(id) DO UPDATE SET
    codigo = excluded.codigo,
    name = excluded.name,
    price = excluded.price,
    wholesale_price = excluded.wholesale_price,
    stock = excluded.stock,
    category_name = excluded.category_name,
    brand_name = excluded.brand_name,
    description = excluded.description,
    image_url = excluded.image_url,
    active = excluded.active,
    synced_at = excluded.synced_at
`);

function buildSearchStmt(wordCount, withCategory) {
  // ILIKE: no PostgreSQL o LIKE diferencia maiúsculas ('sony' não achava 'SONY').
  const perWordClause = 'name ILIKE ? OR brand_name ILIKE ? OR description ILIKE ? OR codigo ILIKE ?';
  const wordClauses = Array.from({ length: wordCount }, () => `(${perWordClause})`).join(' AND ');
  const categoryClause = withCategory ? 'category_name ILIKE ? AND ' : '';
  return db.prepare(`
    SELECT id, codigo, name, price, wholesale_price, stock, category_name, brand_name, description
    FROM products
    WHERE active = 1 AND ${categoryClause}${wordClauses || '1=1'}
    ORDER BY stock DESC
    LIMIT ?
  `);
}

const searchStmtCache = new Map();

function getSearchStmt(wordCount, withCategory) {
  const key = `${wordCount}:${withCategory}`;
  if (!searchStmtCache.has(key)) {
    searchStmtCache.set(key, buildSearchStmt(wordCount, withCategory));
  }
  return searchStmtCache.get(key);
}

function apiUrl(path) {
  const base = process.env.GENOVE_API_BASE_URL || 'https://genove.com.py';
  return `${base}/api${path}`;
}

async function fetchProductsPage(page) {
  const res = await fetch(apiUrl(`/products?per_page=${PER_PAGE}&page=${page}&lang=es`), {
    headers: {
      'X-API-Key': process.env.GENOVE_API_KEY,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Genove API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function pickImageUrl(product) {
  const images = product.images || [];
  const principal = images.find((img) => img.type === 'PRINCIPAL');
  return (principal || images[0] || {}).url || null;
}

// ---------------------------------------------------------------------------
// Catálogo por feed XML (ex.: https://digitalcenterpy.com/xml.xml)
// <rss><channel><item> com <title>, <codigo>, <preco>"529.00 USD", <marca>,
// <disponibilidade>"em estoque", <link_imagem>, <description>.
// O feed não traz quantidade: estoque = 1 (disponível) ou 0 (indisponível).
// ---------------------------------------------------------------------------
function decodificar(texto) {
  return String(texto || '')
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'i'));
  return m ? decodificar(m[1]) : null;
}

function idDoCodigo(codigo) {
  if (/^\d{1,9}$/.test(codigo)) return Number(codigo);
  let h = 0; // código não numérico: id estável derivado do texto
  for (const c of codigo) h = (h * 31 + c.charCodeAt(0)) % 900000000;
  return 1000000000 + h;
}

function lerFeedXml(xml) {
  const itens = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const codigo = tag(b, 'codigo');
    const nome = tag(b, 'title');
    if (!codigo || !nome) continue;
    const preco = Number(String(tag(b, 'preco') || '').replace(/[^\d.]/g, '')) || null;
    const disp = (tag(b, 'disponibilidade') || '').toLowerCase();
    const descricao = (tag(b, 'description') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    itens.push({
      id: idDoCodigo(codigo), codigo, nome, preco,
      estoque: /sem estoque|esgotad|indispon|out of stock/.test(disp) ? 0
        : (/em estoque|in stock|disponivel|disponível/.test(disp) ? 1 : 0),
      marca: tag(b, 'marca'),
      categoria: tag(b, 'tipo_venda'),
      descricao: descricao.slice(0, 1000) || null,
      imagem: tag(b, 'link_imagem'),
    });
  }
  return itens;
}

async function syncProductsXml(url) {
  const res = await fetch(url, { headers: { Accept: 'application/xml,text/xml,*/*' } });
  if (!res.ok) throw new Error(`Feed XML ${res.status}`);
  const itens = lerFeedXml(await res.text());
  if (!itens.length) throw new Error('Feed XML sem itens reconhecíveis.');

  const inicio = new Date().toISOString();
  for (const p of itens) {
    await upsertStmt.run(p.id, p.codigo, p.nome, p.preco, null, p.estoque, p.categoria, p.marca,
      p.descricao, p.imagem, 1);
  }
  // o que saiu do feed deixa de ser oferecido
  await db.prepare('UPDATE products SET active = 0 WHERE synced_at < ?').run(inicio);
  return itens.length;
}

async function syncProducts() {
  if (process.env.CATALOGO_XML_URL) return syncProductsXml(process.env.CATALOGO_XML_URL);
  if (!process.env.GENOVE_API_KEY) throw new Error('Defina CATALOGO_XML_URL ou GENOVE_API_KEY no .env.');
  let page = 1;
  let totalSynced = 0;
  let lastPage = 1;

  do {
    const body = await fetchProductsPage(page);
    const items = body.data || [];

    // Sem BEGIN/COMMIT: com o pool do pg cada comando pode ir para uma
    // conexão diferente, e a transação não valeria. O upsert é idempotente.
    {
      for (const product of items) {
        await upsertStmt.run(
          product.id,
          product.codigo != null ? String(product.codigo) : null,
          product.name,
          product.price,
          product.wholesale_price,
          product.stock,
          (product.category && product.category.name) || null,
          (product.brand && product.brand.name) || null,
          product.details || product.feature || null,
          pickImageUrl(product),
          product.active ? 1 : 0
        );
        totalSynced++;
      }
    }

    lastPage = (body.meta && body.meta.last_page) || page;
    page++;
  } while (page <= lastPage);

  return totalSynced;
}

async function searchProducts({ query, categoryName, limit = 5 } = {}) {
  const words = (query || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const cappedLimit = Math.min(Number(limit) || 5, 10);
  const withCategory = Boolean(categoryName);

  const stmt = getSearchStmt(words.length, withCategory);
  const params = [];
  if (withCategory) params.push(`%${categoryName}%`);
  for (const word of words) {
    const likeTerm = `%${word}%`;
    params.push(likeTerm, likeTerm, likeTerm, likeTerm);
  }
  params.push(cappedLimit);

  return await stmt.all(...params);
}

async function tick() {
  try {
    const count = await syncProducts();
    logger.info(`Catálogo sincronizado: ${count} produtos.`);
  } catch (err) {
    logger.error('productCatalog: falha ao sincronizar catálogo:', err.message);
  }
}

async function startCatalogScheduler() {
  await tick(); // sincronização inicial, sem bloquear o boot do servidor
  setInterval(tick, SYNC_INTERVAL_MS);
}

module.exports = { syncProducts, searchProducts, startCatalogScheduler, lerFeedXml };
