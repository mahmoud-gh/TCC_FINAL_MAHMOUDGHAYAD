// Teste de integração do fluxo completo de campanha.
// Cria a própria campanha de teste, exercita o ciclo e limpa o que criou, de
// modo a não depender nem interferir nos dados reais.
//
// Uso: npm run test:db
require('dotenv').config();
const db = require('../src/db');
const engine = require('../src/services/campaignEngine');
const metrics = require('../src/services/campaignMetrics');
const seg = require('../src/services/segmentation');
const consent = require('../src/services/consent');

let falhas = 0;
const ok = (cond, msg) => {
  if (!cond) falhas += 1;
  console.log(`${cond ? '  OK  ' : ' FALHA'}  ${msg}`);
};

const MARCA = `teste-${Date.now()}`;

(async () => {
  const versao = await db.prepare('SELECT version() AS v').get();
  console.log(`\n### ${String(versao.v).split(',')[0]}\n`);

  // --------------------------------------------------------- massa isolada
  const contatos = [];
  for (let i = 1; i <= 4; i += 1) {
    const telefone = `5545999${String(Date.now()).slice(-6)}${i}`;
    const r = await db.prepare(`
      INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil, ultima_interacao)
      VALUES ('whatsapp', ?, ?, ?, ?, now())
    `).run(telefone, `Contato Teste ${i}`, telefone, MARCA);
    contatos.push({ id: Number(r.lastInsertRowid), telefone });
  }
  for (let i = 0; i < 3; i += 1) {
    await consent.registrar({
      contactId: contatos[i].id, tipo: 'opt_in',
      finalidade: 'teste automatizado', origem: MARCA,
    });
  }
  // o terceiro revoga: deve ficar inelegível; o quarto nunca se manifestou
  await consent.registrar({
    contactId: contatos[2].id, tipo: 'opt_out',
    finalidade: 'teste automatizado', origem: MARCA,
  });

  const rSeg = await db.prepare('INSERT INTO segmentos (nome, descricao) VALUES (?, ?)')
    .run(`Segmento ${MARCA}`, 'criado pelo teste de integração');
  const segmentoId = Number(rSeg.lastInsertRowid);
  await db.prepare(`
    INSERT INTO regras_segmentacao (segmento_id, atributo, operador, valor_referencia, ordem)
    VALUES (?, 'perfil', 'igual', ?, 0)
  `).run(segmentoId, MARCA);

  const rMod = await db.prepare(`
    INSERT INTO modelos_mensagem (nome, corpo, parametros, situacao_aprovacao)
    VALUES (?, 'Ola {{1}}, confira: {{2}}', '["display_name","_link"]', 'aprovado')
  `).run(`modelo_${MARCA}`);
  const modeloId = Number(rMod.lastInsertRowid);

  const rCamp = await db.prepare(`
    INSERT INTO campanhas (nome, segmento_id, modelo_id, cenario, url_destino, situacao)
    VALUES (?, ?, ?, 'automatizado', 'https://exemplo.test/promo', 'rascunho')
  `).run(`Campanha ${MARCA}`, segmentoId, modeloId);
  const campanhaId = Number(rCamp.lastInsertRowid);

  // --------------------------------------------------------------- testes
  const previa = await seg.previa(segmentoId);
  ok(previa.total === 4 && previa.elegiveis === 2,
     `segmentação: ${previa.total} no segmento, ${previa.elegiveis} elegíveis (1 revogado, 1 sem opt-in)`);

  const resumo = await engine.executarCampanha(campanhaId);
  ok(resumo.enviados === 2 && resumo.nao_elegiveis === 2,
     `execução: ${resumo.enviados} enviado(s), ${resumo.nao_elegiveis} bloqueado(s) por consentimento`);

  const motivos = await db.prepare(
    "SELECT DISTINCT motivo FROM envios WHERE campanha_id = ? AND situacao = 'nao_elegivel' ORDER BY 1"
  ).all(campanhaId);
  ok(motivos.length === 2, `motivos do bloqueio discriminados: ${motivos.map((m) => m.motivo).join(' / ')}`);

  const envio = await db.prepare(
    "SELECT * FROM envios WHERE campanha_id = ? AND situacao = 'enviado' ORDER BY id LIMIT 1"
  ).get(campanhaId);
  ok(!!envio.id_api, `identificador da Cloud API gravado: ${envio.id_api}`);
  ok(/Contato Teste/.test(envio.conteudo), `personalização aplicada: "${envio.conteudo.slice(0, 45)}..."`);

  await engine.registrarStatusWebhook({ platformMessageId: envio.id_api, status: 'delivered' });
  const dup = await engine.registrarStatusWebhook({ platformMessageId: envio.id_api, status: 'delivered' });
  ok(dup === false, 'idempotência: reentrega da mesma notificação não duplica evento');
  await engine.registrarStatusWebhook({ platformMessageId: envio.id_api, status: 'read' });

  const link = await db.prepare('SELECT * FROM links_rastreados WHERE envio_id = ?').get(envio.id);
  const destino = await engine.registrarClique(link.token);
  ok(destino === 'https://exemplo.test/promo', `clique registrado e redirecionado para ${destino}`);

  await engine.registrarResposta(envio.contact_id, { message_id: 'wamid.teste' });
  const segunda = await engine.registrarResposta(envio.contact_id, { message_id: 'wamid.teste2' });
  ok(segunda === false, 'apenas a primeira resposta conta para a taxa');

  await engine.registrarConversao({ envioId: envio.id, valor: 250, origem: 'manual' });

  const m = await metrics.recalcular(campanhaId);
  ok(m.total_enviados === 2 && m.total_respostas === 1 && m.taxa_resposta === 0.5,
     `métricas: resposta ${m.taxa_resposta}, clique ${m.taxa_clique}, conversão ${m.taxa_conversao}`);

  const vista = await db.prepare('SELECT * FROM vw_campanha_desempenho WHERE campanha_id = ?').get(campanhaId);
  ok(Number(vista.respostas) === m.total_respostas && Number(vista.enviados) === m.total_enviados,
     'visão vw_campanha_desempenho confere com a tabela consolidada');

  await db.prepare("UPDATE campanhas SET situacao = 'agendada' WHERE id = ?").run(campanhaId);
  const repeticao = await engine.executarCampanha(campanhaId);
  ok(repeticao.enviados === 0 && repeticao.ja_processados === 4,
     'reexecução não reenvia: os contatos já processados são ignorados');

  await db.prepare("UPDATE modelos_mensagem SET situacao_aprovacao = 'pendente' WHERE id = ?").run(modeloId);
  const rOutra = await db.prepare(`
    INSERT INTO campanhas (nome, segmento_id, modelo_id, cenario, situacao)
    VALUES (?, ?, ?, 'automatizado', 'rascunho')
  `).run(`Campanha 2 ${MARCA}`, segmentoId, modeloId);
  let recusou = false;
  try { await engine.executarCampanha(Number(rOutra.lastInsertRowid)); } catch { recusou = true; }
  ok(recusou, 'modelo não aprovado é recusado pelo motor (RNF03)');

  ok(engine.ehPedidoDeOptOut('SAIR') && !engine.ehPedidoDeOptOut('oi'),
     'palavra-chave de opt-out reconhecida');

  const contato = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(envio.contact_id);
  await engine.processarOptOut(contato, 'sair');
  ok((await consent.estaElegivel(contato.id)) === false, 'opt-out torna o contato inelegível na hora');

  let bloqueou = false;
  try {
    await db.prepare('UPDATE consentimentos SET tipo = ? WHERE contact_id = ?').run('opt_in', contatos[0].id);
  } catch { bloqueou = true; }
  ok(bloqueou, 'banco recusa alterar registro de consentimento (imutabilidade)');

  // -------------------------------------------------------------- limpeza
  for (const id of [campanhaId, Number(rOutra.lastInsertRowid)]) {
    await db.prepare('DELETE FROM eventos_interacao WHERE campanha_id = ?').run(id);
    await db.prepare('DELETE FROM conversoes WHERE campanha_id = ?').run(id);
    await db.prepare('DELETE FROM links_rastreados WHERE envio_id IN (SELECT id FROM envios WHERE campanha_id = ?)').run(id);
    await db.prepare('DELETE FROM envios WHERE campanha_id = ?').run(id);
    await db.prepare('DELETE FROM metricas_campanha WHERE campanha_id = ?').run(id);
    await db.prepare('DELETE FROM registros_execucao_fluxo WHERE campanha_id = ?').run(id);
    await db.prepare('DELETE FROM campanhas WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM regras_segmentacao WHERE segmento_id = ?').run(segmentoId);
  await db.prepare('DELETE FROM segmentos WHERE id = ?').run(segmentoId);
  await db.prepare('DELETE FROM modelos_mensagem WHERE id = ?').run(modeloId);
  for (const c of contatos) {
    await db.prepare('DELETE FROM eventos_interacao WHERE contact_id = ?').run(c.id);
    // Registros de consentimento são imutáveis por gatilho: os contatos de
    // teste são anonimizados, o que também exercita a rotina do art. 18.
    await db.prepare(
      "UPDATE contacts SET display_name = 'contato de teste (removido)', phone = NULL, anonimizado = 1, perfil = NULL WHERE id = ?"
    ).run(c.id);
  }

  console.log(`\n${falhas ? `${falhas} verificacao(oes) falharam.` : 'Todas as verificacoes passaram.'}\n`);
  await db.close();
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error('ERRO NO TESTE:', e);
  process.exit(1);
});
