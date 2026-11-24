const express = require('express');
const { stmt } = require('../db/stmt');
const segmentation = require('../services/segmentation');

const router = express.Router();

// RF03 — definição das regras e aplicação automática sobre a base.

router.param('id', (req, res, next, id) => (
  /^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Segmento não encontrado.' })
));

router.get('/metadados', (req, res) => {
  res.json({
    atributos: segmentation.listarAtributos(),
    operadores: segmentation.listarOperadores(),
  });
});

router.get('/', async (req, res) => {
  const segmentos = await stmt(`
    SELECT s.*,
           (SELECT COUNT(*) FROM regras_segmentacao r WHERE r.segmento_id = s.id) AS total_regras,
           (SELECT COUNT(*) FROM campanhas c WHERE c.segmento_id = s.id) AS total_campanhas
    FROM segmentos s ORDER BY s.nome
  `).all();
  const regras = await stmt('SELECT * FROM regras_segmentacao ORDER BY segmento_id, ordem, id').all();
  res.json(segmentos.map((s) => ({ ...s, regras: regras.filter((r) => r.segmento_id === s.id) })));
});

// Prévia de regras ainda não salvas (o editor atualiza enquanto o usuário monta).
router.post('/previa', async (req, res) => {
  try {
    const regras = Array.isArray((req.body || {}).regras) ? req.body.regras : [];
    validarRegras(regras);
    res.json(await segmentation.previaRegras(regras));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const segmento = await stmt('SELECT * FROM segmentos WHERE id = ?').get(req.params.id);
  if (!segmento) return res.status(404).json({ error: 'Segmento não encontrado.' });
  res.json({ ...segmento, regras: await segmentation.regrasDoSegmento(segmento.id) });
});

router.get('/:id/previa', async (req, res) => {
  const segmento = await stmt('SELECT id FROM segmentos WHERE id = ?').get(req.params.id);
  if (!segmento) return res.status(404).json({ error: 'Segmento não encontrado.' });
  try {
    res.json(await segmentation.previa(segmento.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Valida todas as regras antes de mexer no banco e grava uma por vez, em ordem.
// (Antes era forEach(async ...): a resposta saía antes de gravar — a prévia logo
// depois podia contar o segmento sem regras — e uma regra inválida derrubava o servidor.)
function validarRegras(regras) {
  (regras || []).forEach((regra) => segmentation.validarRegra(regra));
}

async function salvarRegras(segmentoId, regras) {
  validarRegras(regras);
  await stmt('DELETE FROM regras_segmentacao WHERE segmento_id = ?').run(segmentoId);
  for (const [indice, regra] of (regras || []).entries()) {
    await stmt(`
      INSERT INTO regras_segmentacao (segmento_id, atributo, operador, valor_referencia, ordem)
      VALUES (?, ?, ?, ?, ?)
    `).run(segmentoId, regra.atributo, regra.operador, regra.valor_referencia ?? null, indice);
  }
}

router.post('/', async (req, res) => {
  const { nome, descricao, regras } = req.body || {};
  if (!nome) return res.status(400).json({ error: 'Nome do segmento é obrigatório.' });

  try {
    validarRegras(regras); // não cria o segmento se alguma regra for inválida
    const r = await stmt('INSERT INTO segmentos (nome, descricao) VALUES (?, ?)').run(nome, descricao || null);
    const id = Number(r.lastInsertRowid);
    await salvarRegras(id, regras);
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const segmento = await stmt('SELECT id FROM segmentos WHERE id = ?').get(req.params.id);
  if (!segmento) return res.status(404).json({ error: 'Segmento não encontrado.' });

  const { nome, descricao, regras } = req.body || {};
  try {
    await stmt("UPDATE segmentos SET nome = ?, descricao = ?, updated_at = now() WHERE id = ?")
      .run(nome, descricao || null, segmento.id);
    await salvarRegras(segmento.id, regras);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const emUso = await stmt('SELECT COUNT(*) AS total FROM campanhas WHERE segmento_id = ?').get(req.params.id);
  if (emUso && emUso.total > 0) {
    return res.status(409).json({ error: 'Segmento usado por campanhas existentes.' });
  }
  await stmt('DELETE FROM regras_segmentacao WHERE segmento_id = ?').run(req.params.id);
  await stmt('DELETE FROM segmentos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
