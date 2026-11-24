(async () => {
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');

// Importa contatos de um arquivo CSV (Google Contatos, Outlook, planilha simples)
// ou vCard (.vcf exportado da agenda do celular).
//
//   node scripts/import-contacts.js contatos.csv
//   node scripts/import-contacts.js contatos.vcf --ddi 55 --perfil varejo
//   node scripts/import-contacts.js contatos.csv --dry-run
//
// IMPORTANTE: a importação NUNCA registra opt-in. O consentimento precisa ser
// manifestado pelo titular e registrado individualmente (painel de Marketing →
// Contatos → Opt-in), com a origem descrita. Contato importado entra na base
// como inelegível e é ignorado por qualquer campanha até que isso aconteça.

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith('--'));
const flag = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : padrao;
};
const dryRun = args.includes('--dry-run');
const DDI = flag('ddi', '55');
const PERFIL = flag('perfil', null);

if (!arquivo) {
  console.error('Uso: node scripts/import-contacts.js <arquivo.csv|arquivo.vcf> [--ddi 55] [--perfil varejo] [--dry-run]');
  process.exit(1);
}

// --------------------------------------------------------------- telefone --
function normalizarTelefone(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^0+/, '');
  if (d.length <= 9) return null;              // sem DDD — não dá pra enviar
  if (d.length === 10 || d.length === 11) d = DDI + d; // faltou o DDI
  if (d.length < 12 || d.length > 15) return null;     // fora do E.164
  return d;
}

// -------------------------------------------------------------------- CSV --
function parseCSV(texto) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i += 1; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',' || c === ';') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((v) => v.trim()));
}

function lerCSV(texto) {
  const linhas = parseCSV(texto);
  if (!linhas.length) return [];

  const cabecalho = linhas[0].map((h) => h.trim().toLowerCase());
  const achaColunas = (termos) =>
    cabecalho.reduce((acc, h, i) => (termos.some((t) => h.includes(t)) ? [...acc, i] : acc), []);

  // Google Contatos traz "Name", "Given Name" e "Family Name" ao mesmo tempo:
  // se houver uma coluna de nome completo, ela sozinha basta.
  const NOMES_COMPLETOS = ['name', 'nome', 'nome completo', 'full name', 'display name', 'contato', 'cliente'];
  const colNomeCompleto = cabecalho.findIndex((h) => NOMES_COMPLETOS.includes(h.trim()));
  const colsNome = colNomeCompleto >= 0
    ? [colNomeCompleto]
    : achaColunas(['nome', 'name', 'contato', 'cliente']);
  const colsFone = achaColunas(['phone', 'telefone', 'celular', 'fone', 'whatsapp', 'número', 'numero']);

  if (!colsFone.length) {
    throw new Error(
      `Nenhuma coluna de telefone encontrada. Cabeçalho lido: ${cabecalho.join(' | ')}`
    );
  }

  return linhas.slice(1).map((linha) => {
    const nome = colsNome.map((i) => (linha[i] || '').trim()).filter(Boolean).join(' ').trim();
    const fone = colsFone.map((i) => (linha[i] || '').trim()).find((v) => normalizarTelefone(v));
    return { nome: nome || null, telefone: fone || null };
  });
}

// ------------------------------------------------------------------ vCard --
function lerVCard(texto) {
  const registros = texto.split(/END:VCARD/i);
  const contatos = [];

  for (const bloco of registros) {
    if (!/BEGIN:VCARD/i.test(bloco)) continue;
    const linhas = bloco.split(/\r?\n/);

    let nome = null;
    const telefones = [];
    for (const linha of linhas) {
      if (/^FN[;:]/i.test(linha)) nome = linha.split(':').slice(1).join(':').trim();
      else if (!nome && /^N[;:]/i.test(linha)) {
        nome = linha.split(':').slice(1).join(':').split(';').filter(Boolean).reverse().join(' ').trim();
      } else if (/^TEL/i.test(linha)) {
        telefones.push(linha.split(':').slice(1).join(':').trim());
      }
    }
    const fone = telefones.find((t) => normalizarTelefone(t));
    if (fone) contatos.push({ nome: nome || null, telefone: fone });
  }
  return contatos;
}

// ----------------------------------------------------------------- import --
const caminho = path.resolve(arquivo);
if (!fs.existsSync(caminho)) {
  console.error(`Arquivo não encontrado: ${caminho}`);
  process.exit(1);
}

const conteudo = fs.readFileSync(caminho, 'utf8');
const brutos = /\.vcf$/i.test(caminho) ? lerVCard(conteudo) : lerCSV(conteudo);

const getStmt = db.prepare(
  "SELECT id, display_name FROM contacts WHERE platform = 'whatsapp' AND platform_user_id = ?"
);
const insertStmt = db.prepare(`
  INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil)
  VALUES ('whatsapp', ?, ?, ?, ?)
`);
const updateNomeStmt = db.prepare(`
  UPDATE contacts SET display_name = ?, updated_at = now()
  WHERE id = ? AND (display_name IS NULL OR display_name = '')
`);

const resumo = { lidos: brutos.length, criados: 0, atualizados: 0, duplicados: 0, invalidos: 0 };
const vistos = new Set();

for (const bruto of brutos) {
  const telefone = normalizarTelefone(bruto.telefone);
  if (!telefone) { resumo.invalidos += 1; continue; }
  if (vistos.has(telefone)) { resumo.duplicados += 1; continue; }
  vistos.add(telefone);

  const existente = await getStmt.get(telefone);
  if (existente) {
    if (!dryRun && bruto.nome) await updateNomeStmt.run(bruto.nome, existente.id);
    resumo.atualizados += 1;
  } else {
    if (!dryRun) await insertStmt.run(telefone, bruto.nome, telefone, PERFIL);
    resumo.criados += 1;
  }
}

console.log(`\nArquivo: ${caminho}`);
console.log(`Registros lidos:        ${resumo.lidos}`);
console.log(`Novos contatos:         ${resumo.criados}`);
console.log(`Já existiam:            ${resumo.atualizados}`);
console.log(`Duplicados no arquivo:  ${resumo.duplicados}`);
console.log(`Sem telefone válido:    ${resumo.invalidos}`);
if (dryRun) console.log('\n(--dry-run: nada foi gravado)');
console.log(
  '\nTodos entraram SEM consentimento e não recebem campanha até que o opt-in\n' +
    'seja registrado individualmente no painel de Marketing → Contatos.\n'
);

await db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
