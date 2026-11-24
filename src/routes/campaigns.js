const express = require('express');
const { stmt } = require('../db/stmt');
const segmentation = require('../services/segmentation');
const campaignEngine = require('../services/campaignEngine');
const metrics = require('../services/campaignMetrics');

const router = express.Router();

// id não numérico não chega ao banco (o erro do PostgreSQL deixava a requisição sem resposta)
router.param('id', (req, res, next, id) => (
  /^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Campanha não encontrada.' })
));

// RF05, RF06, RF08, RF10, RF11

// ---- Comparativo entre cenários (Seção 3.5) — antes das rotas com :id -------
router.get('/comparativo', async (req, res) => {
  res.json(await metrics.comparativoPorCenario());
});

router.get('/', async (req, res) => {
  const campanhas = await stmt(`
    SELECT c.*, s.nome AS segmento_nome, m.nome AS modelo_nome, m.situacao_aprovacao,
           mc.total_elegiveis, mc.total_enviados, mc.total_entregues, mc.total_lidos,
           mc.total_respostas, mc.total_cliques, mc.total_conversoes,
           mc.taxa_resposta, mc.taxa_clique, mc.taxa_conversao, mc.tempo_medio_resposta,
           u.name AS criado_por_nome
    FROM campanhas c
    JOIN segmentos s ON s.id = c.segmento_id
    JOIN modelos_mensagem m ON m.id = c.modelo_id
    LEFT JOIN metricas_campanha mc ON mc.campanha_id = c.id
    LEFT JOIN users u ON u.id = c.criado_por
    ORDER BY c.created_at DESC
  `).all();
  res.json(campanhas);
});

router.get('/:id', async (req, res) => {
  const campanha = await stmt(`
    SELECT c.*, s.nome AS segmento_nome, s.descricao AS segmento_descricao,
           m.nome AS modelo_nome, m.corpo, m.parametros AS modelo_parametros, m.situacao_aprovacao,
           u.name AS criado_por_nome
    FROM campanhas c
    JOIN segmentos s ON s.id = c.segmento_id
    JOIN modelos_mensagem m ON m.id = c.modelo_id
    LEFT JOIN users u ON u.id = c.criado_por
    WHERE c.id = ?
  `).get(req.params.id);
  if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada.' });

  res.json({
    ...campanha,
    metricas: await metrics.obter(campanha.id),
    execucoes: await stmt(`
      SELECT * FROM registros_execucao_fluxo WHERE campanha_id = ? ORDER BY inicio DESC LIMIT 20
    `).all(campanha.id),
  });
});

router.post('/', async (req, res) => {
  const { nome, segmento_id, modelo_id, cenario, agendamento, url_destino } = req.body || {};
  if (!nome || !segmento_id || !modelo_id || !cenario) {
    return res.status(400).json({ error: 'nome, segmento_id, modelo_id e cenario são obrigatórios.' });
  }
  if (!['manual', 'automatizado'].includes(cenario)) {
    return res.status(400).json({ error: 'cenario deve ser manual ou automatizado.' });
  }

  try {
    const r = await stmt(`
      INSERT INTO campanhas (nome, segmento_id, modelo_id, cenario, agendamento, url_destino, situacao, criado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nome,
      segmento_id,
      modelo_id,
      cenario,
      agendamento || null,
      url_destino || null,
      agendamento ? 'agendada' : 'rascunho',
      req.user && req.user.id
    );
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const campanha = await stmt('SELECT * FROM campanhas WHERE id = ?').get(req.params.id);
  if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada.' });

  const { nome, agendamento, url_destino, situacao } = req.body || {};
  await stmt(`
    UPDATE campanhas
    SET nome = COALESCE(?, nome),
        agendamento = COALESCE(?, agendamento),
        url_destino = COALESCE(?, url_destino),
        situacao = COALESCE(?, situacao),
        updated_at = now()
    WHERE id = ?
  `).run(nome || null, agendamento || null, url_destino || null, situacao || null, campanha.id);

  res.json({ ok: true });
});

// Prévia dos destinatários: quem entra, quem fica de fora e por quê (RF06).
router.get('/:id/destinatarios', async (req, res) => {
  const campanha = await stmt('SELECT * FROM campanhas WHERE id = ?').get(req.params.id);
  if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada.' });

  const contatos = await segmentation.resolver(campanha.segmento_id, { plataforma: 'whatsapp' });
  res.json({
    total: contatos.length,
    elegiveis: contatos.filter((c) => c.elegivel).length,
    contatos: contatos.map((c) => ({
      id: c.id,
      display_name: c.display_name,
      phone: c.phone,
      perfil: c.perfil,
      nivel_engajamento: c.nivel_engajamento,
      elegivel: Boolean(c.elegivel),
    })),
  });
});

// RF08 — disparo automatizado.
router.post('/:id/executar', async (req, res) => {
  try {
    const resumo = await campaignEngine.executarCampanha(Number(req.params.id));
    res.json(resumo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cenário manual: registra um envio feito pelo operador (linha de base).
router.post('/:id/envios-manuais', async (req, res) => {
  const { contact_id, conteudo, id_api, message_id } = req.body || {};
  if (!contact_id) return res.status(400).json({ error: 'contact_id é obrigatório.' });

  try {
    const { envioId, linkRastreado } = await campaignEngine.registrarEnvioManual({
      campanhaId: Number(req.params.id),
      contactId: Number(contact_id),
      conteudo,
      idApi: id_api,
      messageId: message_id,
    });
    res.status(201).json({ envio_id: envioId, link_rastreado: linkRastreado });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/envios', async (req, res) => {
  const envios = await stmt(`
    SELECT e.*, c.display_name, c.phone,
           (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'entregue') AS entregue,
           (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'lido') AS lido,
           (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'resposta') AS respondeu,
           (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'clique') AS cliques,
           (SELECT COUNT(*) FROM conversoes cv WHERE cv.envio_id = e.id) AS converteu
    FROM envios e
    JOIN contacts c ON c.id = e.contact_id
    WHERE e.campanha_id = ?
    ORDER BY e.id
  `).all(req.params.id);
  res.json(envios);
});

router.get('/:id/eventos', async (req, res) => {
  res.json(await stmt(`
    SELECT ev.*, c.display_name
    FROM eventos_interacao ev
    JOIN contacts c ON c.id = ev.contact_id
    WHERE ev.campanha_id = ?
    ORDER BY ev.data_hora DESC, ev.id DESC
    LIMIT 500
  `).all(req.params.id));
});

// Conversão: registrada explicitamente, pois ocorre fora do canal.
router.post('/:id/conversoes', async (req, res) => {
  const { envio_id, valor, origem, observacao } = req.body || {};
  if (!envio_id) return res.status(400).json({ error: 'envio_id é obrigatório.' });

  try {
    const metricas = await campaignEngine.registrarConversao({
      envioId: Number(envio_id),
      valor,
      origem,
      observacao,
      usuarioId: req.user && req.user.id,
    });
    res.status(201).json(metricas);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// RF10 — métricas por campanha.
router.get('/:id/metricas', async (req, res) => {
  const campanha = await stmt('SELECT id FROM campanhas WHERE id = ?').get(req.params.id);
  if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada.' });
  res.json(await metrics.recalcular(campanha.id));
});

module.exports = router;
