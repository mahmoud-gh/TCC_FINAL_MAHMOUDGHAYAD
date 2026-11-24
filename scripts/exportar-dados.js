require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');

// Exporta os dados das campanhas em CSV, para análise externa
// (planilha, R, Python) e para compor as tabelas do capítulo de resultados.
//
//   npm run exportar
//   npm run exportar -- --pasta resultados-2026-11-08
//
// Cada arquivo corresponde a uma visão do banco, de modo que o dado exportado é
// o mesmo que o sistema calcula — sem transformação intermediária.

const args = process.argv.slice(2);
const flag = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : padrao;
};

const carimbo = new Date().toISOString().slice(0, 10);
const PASTA = path.resolve(flag('pasta', `exportacao-${carimbo}`));

const CONSULTAS = [
  ['envios', 'SELECT * FROM vw_envio_detalhe ORDER BY campanha_id, envio_id',
    'Um registro por envio: situação, carimbos de entrega/leitura/resposta, cliques, tempo de resposta e conversão'],
  ['campanhas', 'SELECT * FROM vw_campanha_desempenho ORDER BY campanha_id',
    'Métricas consolidadas por campanha'],
  ['comparativo-cenarios', 'SELECT * FROM vw_comparativo_cenario ORDER BY cenario',
    'Agregação por cenário — manual x automatizado (Seção 3.5)'],
  ['eventos', `SELECT ev.id, ev.campanha_id, ev.envio_id, ev.contact_id, ev.tipo,
                      ev.id_evento_api, ev.data_hora
               FROM eventos_interacao ev ORDER BY ev.id`,
    'Todos os eventos de interação registrados, com o identificador que garante a idempotência'],
  ['consentimentos', 'SELECT * FROM vw_auditoria_consentimento ORDER BY contact_id, data_hora',
    'Trilha de auditoria do consentimento — histórico completo por titular'],
  ['base-contatos', 'SELECT * FROM vw_consentimento_atual ORDER BY contact_id',
    'Situação de consentimento vigente e atributos de segmentação de cada contato'],
  ['execucoes', 'SELECT * FROM registros_execucao_fluxo ORDER BY id',
    'Registro de cada execução de campanha: início, fim, resultado e resumo'],
];

function paraCsv(linhas) {
  if (!linhas.length) return '';
  const colunas = Object.keys(linhas[0]);
  const escapa = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    colunas.join(','),
    ...linhas.map((l) => colunas.map((c) => escapa(l[c])).join(',')),
  ].join('\n');
}

(async () => {
  fs.mkdirSync(PASTA, { recursive: true });

  const indice = [`# Dados brutos da prova de conceito`, `Exportado em ${new Date().toISOString()}`, ''];
  let totalLinhas = 0;

  for (const [nome, sql, descricao] of CONSULTAS) {
    const linhas = await db.prepare(sql).all();
    const arquivo = path.join(PASTA, `${nome}.csv`);
    fs.writeFileSync(arquivo, paraCsv(linhas), 'utf8');
    totalLinhas += linhas.length;
    console.log(`${String(linhas.length).padStart(6)} linha(s)  ${nome}.csv`);
    indice.push(`- **${nome}.csv** (${linhas.length} linhas) — ${descricao}`);
  }

  // Um resumo em texto, para conferência rápida sem abrir os CSVs.
  const comparativo = await db.prepare('SELECT * FROM vw_comparativo_cenario ORDER BY cenario').all();
  if (comparativo.length) {
    indice.push('', '## Comparativo por cenário', '');
    indice.push('| Cenário | Campanhas | Enviados | Respostas | Cliques | Conversões | Taxa resp. | Taxa cliq. | Taxa conv. | Tempo médio |');
    indice.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of comparativo) {
      const tempo = c.tempo_medio_resposta_seg != null
        ? `${(c.tempo_medio_resposta_seg / 60).toFixed(1)} min` : '—';
      indice.push(
        `| ${c.cenario} | ${c.campanhas} | ${c.enviados} | ${c.respostas} | ${c.cliques} | ` +
        `${c.conversoes} | ${(c.taxa_resposta * 100).toFixed(1)}% | ${(c.taxa_clique * 100).toFixed(1)}% | ` +
        `${(c.taxa_conversao * 100).toFixed(1)}% | ${tempo} |`
      );
    }
  }

  fs.writeFileSync(path.join(PASTA, 'LEIA-ME.md'), indice.join('\n'), 'utf8');

  console.log(`\n${totalLinhas} linha(s) exportadas para ${PASTA}`);
  console.log('O arquivo LEIA-ME.md descreve cada CSV e traz o comparativo por cenário.\n');

  await db.close();
})().catch((err) => {
  console.error('Falha na exportação:', err.message);
  process.exit(1);
});
