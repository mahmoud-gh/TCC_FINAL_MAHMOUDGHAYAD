const express = require('express');
const { stmt } = require('../db/stmt');
const { renderizar, ATRIBUTOS_PERMITIDOS } = require('../services/templateRenderer');
const { listarModelosMeta } = require('../services/whatsapp');

const router = express.Router();

// id não numérico não chega ao banco (o erro do PostgreSQL deixava a requisição sem resposta)
router.param('id', (req, res, next, id) => (
  /^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Modelo não encontrado.' })
));

// RF04 — modelos com parâmetros de personalização e situação de aprovação
// junto à plataforma (a Meta só aceita comunicação proativa por modelo aprovado).

const SITUACOES = ['rascunho', 'pendente', 'aprovado', 'rejeitado'];

router.get('/metadados', (req, res) => {
  res.json({ atributos: ATRIBUTOS_PERMITIDOS, situacoes: SITUACOES });
});

router.get('/', async (req, res) => {
  res.json(await stmt(`
    SELECT m.*, (SELECT COUNT(*) FROM campanhas c WHERE c.modelo_id = m.id) AS total_campanhas
    FROM modelos_mensagem m ORDER BY m.nome
  `).all());
});

router.get('/:id', async (req, res) => {
  const modelo = await stmt('SELECT * FROM modelos_mensagem WHERE id = ?').get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'Modelo não encontrado.' });
  res.json(modelo);
});

function normalizarParametros(parametros) {
  const lista = Array.isArray(parametros) ? parametros : [];
  for (const atributo of lista) {
    if (!ATRIBUTOS_PERMITIDOS.includes(atributo) && atributo !== 'primeiro_nome') {
      throw new Error(`Parâmetro não permitido: ${atributo}`);
    }
  }
  return JSON.stringify(lista);
}

router.post('/', async (req, res) => {
  const { nome, idioma, corpo, parametros, situacao_aprovacao } = req.body || {};
  if (!nome || !corpo) return res.status(400).json({ error: 'Nome e corpo são obrigatórios.' });

  try {
    const r = await stmt(`
      INSERT INTO modelos_mensagem (nome, idioma, corpo, parametros, situacao_aprovacao)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      nome,
      idioma || 'pt_BR',
      corpo,
      normalizarParametros(parametros),
      SITUACOES.includes(situacao_aprovacao) ? situacao_aprovacao : 'rascunho'
    );
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const modelo = await stmt('SELECT * FROM modelos_mensagem WHERE id = ?').get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'Modelo não encontrado.' });

  const { nome, idioma, corpo, parametros, situacao_aprovacao } = req.body || {};
  try {
    await stmt(`
      UPDATE modelos_mensagem
      SET nome = ?, idioma = ?, corpo = ?, parametros = ?, situacao_aprovacao = ?, updated_at = now()
      WHERE id = ?
    `).run(
      nome || modelo.nome,
      idioma || modelo.idioma,
      corpo || modelo.corpo,
      parametros ? normalizarParametros(parametros) : modelo.parametros,
      SITUACOES.includes(situacao_aprovacao) ? situacao_aprovacao : modelo.situacao_aprovacao,
      modelo.id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Situação na Meta → situação no painel.
const SITUACAO_META = {
  APPROVED: 'aprovado',
  PENDING: 'pendente',
  IN_APPEAL: 'pendente',
  REJECTED: 'rejeitado',
  DISABLED: 'rejeitado',
  PAUSED: 'rejeitado',
  LIMIT_EXCEEDED: 'rejeitado',
  PENDING_DELETION: 'rejeitado',
  DELETED: 'rejeitado',
  ARCHIVED: 'rejeitado',
};

// Atualiza a situação de aprovação (e o idioma) dos modelos do painel a partir
// dos modelos cadastrados na conta do WhatsApp Business. A ligação é pelo nome,
// que precisa ser igual nos dois lados.
router.post('/sincronizar-meta', async (req, res) => {
  try {
    const daMeta = await listarModelosMeta();
    const locais = await stmt('SELECT id, nome, idioma, situacao_aprovacao FROM modelos_mensagem').all();

    const atualizados = [];
    for (const local of locais) {
      const mesmoNome = daMeta.filter((t) => t.name === local.nome);
      if (!mesmoNome.length) continue;
      const t = mesmoNome.find((x) => x.language === local.idioma) || mesmoNome[0];
      const situacao = SITUACAO_META[t.status] || 'pendente';
      if (situacao !== local.situacao_aprovacao || t.language !== local.idioma) {
        await stmt(`
          UPDATE modelos_mensagem SET situacao_aprovacao = ?, idioma = ?, updated_at = now() WHERE id = ?
        `).run(situacao, t.language, local.id);
        atualizados.push({ nome: local.nome, de: local.situacao_aprovacao, para: situacao, idioma: t.language });
      }
    }

    const nomesLocais = new Set(locais.map((m) => m.nome));
    res.json({
      total_meta: daMeta.length,
      atualizados,
      sem_correspondencia: locais.filter((m) => !daMeta.some((t) => t.name === m.nome)).map((m) => m.nome),
      so_na_meta: [...new Set(daMeta.filter((t) => !nomesLocais.has(t.name)).map((t) => t.name))],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pré-visualização da personalização com um contato real (RF07).
router.post('/:id/previa', async (req, res) => {
  const modelo = await stmt('SELECT * FROM modelos_mensagem WHERE id = ?').get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'Modelo não encontrado.' });

  const contato = req.body && req.body.contact_id
    ? await stmt('SELECT * FROM contacts WHERE id = ?').get(req.body.contact_id)
    : await stmt('SELECT * FROM contacts ORDER BY id LIMIT 1').get();

  if (!contato) return res.status(400).json({ error: 'Nenhum contato disponível para a prévia.' });

  try {
    const render = renderizar(modelo, contato, { link: 'https://exemplo/r/TOKEN' });
    res.json({ texto: render.texto, valores: render.valores });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const emUso = await stmt('SELECT COUNT(*) AS total FROM campanhas WHERE modelo_id = ?').get(req.params.id);
  if (emUso && emUso.total > 0) {
    return res.status(409).json({ error: 'Modelo usado por campanhas existentes.' });
  }
  await stmt('DELETE FROM modelos_mensagem WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
