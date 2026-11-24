const { stmt } = require('../db/stmt');

// RF10 — MetricaCampanha.recalcular()
// Denominador de todas as taxas: mensagens efetivamente aceitas pela Cloud API
// (envios com situacao = 'enviado'). Cada numerador conta envios DISTINTOS, não
// eventos, para que reentrega de webhook ou múltiplos cliques não inflem a taxa.

function taxa(numerador, denominador) {
  if (!denominador) return 0;
  return Number((numerador / denominador).toFixed(4));
}

async function contarEnvios(campanhaId, situacao) {
  const row = await stmt(
    'SELECT COUNT(*) AS total FROM envios WHERE campanha_id = ? AND situacao = ?'
  ).get(campanhaId, situacao);
  return row ? row.total : 0;
}

async function contarEnviosDistintosComEvento(campanhaId, tipo) {
  const row = await stmt(`
    SELECT COUNT(DISTINCT e.envio_id) AS total
    FROM eventos_interacao e
    JOIN envios en ON en.id = e.envio_id
    WHERE e.campanha_id = ? AND e.tipo = ? AND en.situacao = 'enviado'
  `).get(campanhaId, tipo);
  return row ? row.total : 0;
}

// Tempo médio, em segundos, entre o envio e a PRIMEIRA resposta daquele envio.
async function tempoMedioResposta(campanhaId) {
  const row = await stmt(`
    SELECT AVG(segundos) AS media FROM (
      SELECT EXTRACT(EPOCH FROM (MIN(ev.data_hora) - en.data_hora_envio)) AS segundos
      FROM eventos_interacao ev
      JOIN envios en ON en.id = ev.envio_id
      WHERE ev.campanha_id = ? AND ev.tipo = 'resposta' AND en.situacao = 'enviado'
      GROUP BY ev.envio_id, en.data_hora_envio
    ) AS tempos
  `).get(campanhaId);
  return row && row.media != null ? Number(row.media.toFixed(2)) : null;
}

async function recalcular(campanhaId) {
  const enviados = await contarEnvios(campanhaId, 'enviado');
  const entregues = await contarEnviosDistintosComEvento(campanhaId, 'entregue');
  const lidos = await contarEnviosDistintosComEvento(campanhaId, 'lido');
  const respostas = await contarEnviosDistintosComEvento(campanhaId, 'resposta');
  const cliques = await contarEnviosDistintosComEvento(campanhaId, 'clique');

  const conversoesRow = await stmt(`
    SELECT COUNT(*) AS total FROM conversoes WHERE campanha_id = ?
  `).get(campanhaId);
  const conversoes = conversoesRow ? conversoesRow.total : 0;

  const elegiveisRow = await stmt(`
    SELECT COUNT(*) AS total FROM envios WHERE campanha_id = ? AND situacao <> 'nao_elegivel'
  `).get(campanhaId);
  const elegiveis = elegiveisRow ? elegiveisRow.total : 0;

  const metricas = {
    campanha_id: campanhaId,
    total_elegiveis: elegiveis,
    total_enviados: enviados,
    total_entregues: entregues,
    total_lidos: lidos,
    total_respostas: respostas,
    total_cliques: cliques,
    total_conversoes: conversoes,
    taxa_resposta: taxa(respostas, enviados),
    taxa_clique: taxa(cliques, enviados),
    taxa_conversao: taxa(conversoes, enviados),
    tempo_medio_resposta: await tempoMedioResposta(campanhaId),
  };

  await stmt(`
    INSERT INTO metricas_campanha (
      campanha_id, total_elegiveis, total_enviados, total_entregues, total_lidos,
      total_respostas, total_cliques, total_conversoes,
      taxa_resposta, taxa_clique, taxa_conversao, tempo_medio_resposta, calculado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
    ON CONFLICT(campanha_id) DO UPDATE SET
      total_elegiveis = excluded.total_elegiveis,
      total_enviados = excluded.total_enviados,
      total_entregues = excluded.total_entregues,
      total_lidos = excluded.total_lidos,
      total_respostas = excluded.total_respostas,
      total_cliques = excluded.total_cliques,
      total_conversoes = excluded.total_conversoes,
      taxa_resposta = excluded.taxa_resposta,
      taxa_clique = excluded.taxa_clique,
      taxa_conversao = excluded.taxa_conversao,
      tempo_medio_resposta = excluded.tempo_medio_resposta,
      calculado_em = now()
  `).run(
    campanhaId,
    metricas.total_elegiveis,
    metricas.total_enviados,
    metricas.total_entregues,
    metricas.total_lidos,
    metricas.total_respostas,
    metricas.total_cliques,
    metricas.total_conversoes,
    metricas.taxa_resposta,
    metricas.taxa_clique,
    metricas.taxa_conversao,
    metricas.tempo_medio_resposta
  );

  return metricas;
}

async function obter(campanhaId) {
  return (
    await stmt('SELECT * FROM metricas_campanha WHERE campanha_id = ?').get(campanhaId) ||
    await recalcular(campanhaId)
  );
}

async function recalcularPorEnvio(envioId) {
  const envio = await stmt('SELECT campanha_id FROM envios WHERE id = ?').get(envioId);
  if (envio) await recalcular(envio.campanha_id);
}

// Comparação entre os períodos manual e automatizado (Seção 3.5).
async function comparativoPorCenario() {
  const linhas = await stmt(`
    SELECT c.cenario,
           COUNT(DISTINCT c.id) AS campanhas,
           SUM(m.total_enviados) AS enviados,
           SUM(m.total_entregues) AS entregues,
           SUM(m.total_lidos) AS lidos,
           SUM(m.total_respostas) AS respostas,
           SUM(m.total_cliques) AS cliques,
           SUM(m.total_conversoes) AS conversoes,
           AVG(m.tempo_medio_resposta) AS tempo_medio_resposta
    FROM campanhas c
    JOIN metricas_campanha m ON m.campanha_id = c.id
    GROUP BY c.cenario
  `).all();

  return linhas.map((l) => ({
    cenario: l.cenario,
    campanhas: l.campanhas,
    enviados: l.enviados || 0,
    entregues: l.entregues || 0,
    lidos: l.lidos || 0,
    respostas: l.respostas || 0,
    cliques: l.cliques || 0,
    conversoes: l.conversoes || 0,
    taxa_entrega: taxa(l.entregues || 0, l.enviados || 0),
    taxa_leitura: taxa(l.lidos || 0, l.enviados || 0),
    taxa_resposta: taxa(l.respostas || 0, l.enviados || 0),
    taxa_clique: taxa(l.cliques || 0, l.enviados || 0),
    taxa_conversao: taxa(l.conversoes || 0, l.enviados || 0),
    tempo_medio_resposta:
      l.tempo_medio_resposta != null ? Number(l.tempo_medio_resposta.toFixed(2)) : null,
  }));
}

module.exports = { recalcular, recalcularPorEnvio, obter, comparativoPorCenario };
