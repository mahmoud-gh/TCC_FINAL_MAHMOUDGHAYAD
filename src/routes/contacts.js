const express = require('express');
const { stmt } = require('../db/stmt');
const consent = require('../services/consent');
const interesses = require('../services/interesses');

const router = express.Router();

// interesse_declarado é tratado à parte: vira marcações do catálogo de interesses.
const CAMPOS_EDITAVEIS = ['display_name', 'phone', 'perfil', 'nivel_engajamento'];

// RF01 — cadastro de contatos com os atributos usados na segmentação.
router.get('/', async (req, res) => {
  await interesses.garantirEsquema();
  const busca = `%${(req.query.busca || '').trim()}%`;
  const contatos = await stmt(`
    SELECT c.*,
           (SELECT tipo FROM consentimentos k WHERE k.contact_id = c.id
             ORDER BY k.data_hora DESC, k.id DESC LIMIT 1) AS consentimento_atual,
           (SELECT data_hora FROM consentimentos k WHERE k.contact_id = c.id
             ORDER BY k.data_hora DESC, k.id DESC LIMIT 1) AS consentimento_em
    FROM contacts c
    WHERE (? = '%%' OR COALESCE(c.display_name,'') LIKE ? OR COALESCE(c.phone,'') LIKE ?)
    ORDER BY c.display_name IS NULL, c.display_name, c.id
    LIMIT 500
  `).all(busca, busca, busca);

  res.json(contatos.map((c) => ({ ...c, elegivel: c.consentimento_atual === 'opt_in' })));
});

// ------------------------------------------------ catálogo de interesses ----
// (declarado antes de "/:id" para "/interesses" não ser lido como um id)
const tratar = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(/não encontrado/i.test(err.message) ? 404 : 400).json({ error: err.message });
  }
};

router.get('/interesses', tratar(async (req, res) => {
  res.json(await interesses.listar());
}));

router.post('/interesses', tratar(async (req, res) => {
  const interesse = await interesses.criar((req.body || {}).nome);
  res.status(interesse.criado ? 201 : 200).json(interesse);
}));

router.patch('/interesses/:id', tratar(async (req, res) => {
  res.json(await interesses.renomear(req.params.id, (req.body || {}).nome));
}));

router.delete('/interesses/:id', tratar(async (req, res) => {
  res.json(await interesses.excluir(req.params.id));
}));

// Ficha completa do contato (modal do painel de marketing): dados, histórico
// de consentimento, conversas e campanhas recebidas.
router.get('/:id', async (req, res) => {
  const contato = await stmt('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contato) return res.status(404).json({ error: 'Contato não encontrado.' });

  const [consentimentos, conversas, campanhas, ultimaMensagem, doContato, catalogo] = await Promise.all([
    consent.historico(contato.id),
    stmt(`
      SELECT cv.id, cv.status, cv.platform, cv.last_message_at, cv.created_at,
             u.name AS atendente,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'in') AS recebidas,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'out') AS enviadas,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'out'
                AND m.origin IN ('bot','ai')) AS do_bot
      FROM conversations cv
      LEFT JOIN users u ON u.id = cv.assigned_user_id
      WHERE cv.contact_id = ?
      ORDER BY cv.last_message_at DESC NULLS LAST, cv.id DESC
    `).all(contato.id),
    stmt(`
      SELECT e.id, e.situacao, e.motivo, e.data_hora_envio,
             ca.id AS campanha_id, ca.nome AS campanha, ca.cenario,
             EXISTS (SELECT 1 FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'entregue') AS entregue,
             EXISTS (SELECT 1 FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'lido') AS lido,
             EXISTS (SELECT 1 FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'resposta') AS respondeu,
             (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'clique') AS cliques,
             EXISTS (SELECT 1 FROM conversoes cv WHERE cv.envio_id = e.id) AS converteu
      FROM envios e
      JOIN campanhas ca ON ca.id = e.campanha_id
      WHERE e.contact_id = ?
      ORDER BY e.data_hora_envio DESC, e.id DESC
      LIMIT 50
    `).all(contato.id),
    stmt(`
      SELECT m.content, m.direction, m.message_type, m.origin, m.created_at
      FROM messages m
      JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.contact_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    `).get(contato.id),
    interesses.doContato(contato.id),
    interesses.listar(),
  ]);

  const atual = consentimentos[0] || null;
  res.json({
    ...contato,
    elegivel: Boolean(atual && atual.tipo === 'opt_in'),
    consentimento_atual: atual ? atual.tipo : null,
    consentimentos,
    conversas,
    campanhas,
    ultima_mensagem: ultimaMensagem || null,
    interesses: doContato,
    catalogo_interesses: catalogo,
    finalidade_padrao: consent.FINALIDADE_PADRAO,
  });
});

router.post('/', async (req, res) => {
  const { display_name, phone, perfil, interesse_declarado, nivel_engajamento } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório.' });

  const numero = String(phone).replace(/\D/g, '');
  const existente = await stmt(
    "SELECT id FROM contacts WHERE platform = 'whatsapp' AND platform_user_id = ?"
  ).get(numero);
  if (existente) return res.status(409).json({ error: 'Já existe um contato com esse número.' });

  const r = await stmt(`
    INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil, interesse_declarado, nivel_engajamento)
    VALUES ('whatsapp', ?, ?, ?, ?, ?, ?)
  `).run(
    numero,
    display_name || null,
    numero,
    perfil || null,
    interesse_declarado || null,
    nivel_engajamento || null
  );

  const novoId = Number(r.lastInsertRowid);
  if (interesse_declarado) await interesses.definirPorTexto(novoId, interesse_declarado);
  res.status(201).json(await stmt('SELECT * FROM contacts WHERE id = ?').get(novoId));
});

// Marca exatamente estes interesses no contato: { ids: [1, 4, 7] }.
router.put('/:id/interesses', tratar(async (req, res) => {
  const contato = await stmt('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contato) return res.status(404).json({ error: 'Contato não encontrado.' });
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Envie { "ids": [...] }.' });
  const lista = await interesses.definirDoContato(contato.id, ids);
  res.json({ interesses: lista, interesse_declarado: lista.map((i) => i.nome).join(', ') || null });
}));

router.patch('/:id', async (req, res) => {
  const contato = await stmt('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contato) return res.status(404).json({ error: 'Contato não encontrado.' });

  const campos = [];
  const valores = [];
  for (const campo of CAMPOS_EDITAVEIS) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, campo)) {
      campos.push(`${campo} = ?`);
      valores.push(req.body[campo] || null);
    }
  }
  const temInteresse = req.body && Object.prototype.hasOwnProperty.call(req.body, 'interesse_declarado');
  if (!campos.length && !temInteresse) return res.status(400).json({ error: 'Nada para atualizar.' });

  if (campos.length) {
    valores.push(req.params.id);
    await stmt(`UPDATE contacts SET ${campos.join(', ')}, updated_at = now() WHERE id = ?`)
      .run(...valores);
  }
  if (temInteresse) await interesses.definirPorTexto(contato.id, req.body.interesse_declarado);

  res.json(await stmt('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

// Importação em lote. NUNCA concede consentimento automaticamente: o opt-in tem
// de ser registrado depois, com origem própria (decisão alinhada à LGPD).
router.post('/importar', async (req, res) => {
  const lista = Array.isArray(req.body && req.body.contatos) ? req.body.contatos : null;
  if (!lista) return res.status(400).json({ error: 'Envie { "contatos": [...] }.' });

  const resumo = { criados: 0, atualizados: 0, ignorados: 0 };
  for (const item of lista) {
    const numero = String(item.phone || '').replace(/\D/g, '');
    if (!numero) {
      resumo.ignorados += 1;
      continue;
    }
    const existente = await stmt(
      "SELECT id FROM contacts WHERE platform = 'whatsapp' AND platform_user_id = ?"
    ).get(numero);

    if (existente) {
      await stmt(`
        UPDATE contacts SET
          display_name = COALESCE(?, display_name),
          perfil = COALESCE(?, perfil),
          interesse_declarado = COALESCE(?, interesse_declarado),
          nivel_engajamento = COALESCE(?, nivel_engajamento),
          updated_at = now()
        WHERE id = ?
      `).run(
        item.display_name || null,
        item.perfil || null,
        item.interesse_declarado || null,
        item.nivel_engajamento || null,
        existente.id
      );
      if (item.interesse_declarado) await interesses.definirPorTexto(existente.id, item.interesse_declarado);
      resumo.atualizados += 1;
    } else {
      await stmt(`
        INSERT INTO contacts (platform, platform_user_id, display_name, phone, perfil, interesse_declarado, nivel_engajamento)
        VALUES ('whatsapp', ?, ?, ?, ?, ?, ?)
      `).run(
        numero,
        item.display_name || null,
        numero,
        item.perfil || null,
        item.interesse_declarado || null,
        item.nivel_engajamento || null
      );
      const criado = await stmt(
        "SELECT id FROM contacts WHERE platform = 'whatsapp' AND platform_user_id = ?"
      ).get(numero);
      if (item.interesse_declarado && criado) await interesses.definirPorTexto(criado.id, item.interesse_declarado);
      resumo.criados += 1;
    }
  }

  res.json({ ...resumo, aviso: 'Importação não concede opt-in: registre o consentimento por contato.' });
});

// RNF02 — anonimização dos dados pessoais usados na análise, preservando as
// métricas já coletadas (os envios e eventos continuam vinculados ao id).
router.post('/:id/anonimizar', async (req, res) => {
  const contato = await stmt('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contato) return res.status(404).json({ error: 'Contato não encontrado.' });

  await stmt(`
    UPDATE contacts
    SET display_name = ?, phone = NULL, profile_pic_url = NULL, anonimizado = 1,
        updated_at = now()
    WHERE id = ?
  `).run(`Participante ${contato.id}`, contato.id);

  res.json({ ok: true, aviso: 'Contato anonimizado e removido de campanhas futuras.' });
});

// RF02 — histórico e registro de consentimento.
router.get('/:id/consentimentos', async (req, res) => {
  res.json(await consent.historico(req.params.id));
});

router.post('/:id/consentimentos', async (req, res) => {
  const contato = await stmt('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contato) return res.status(404).json({ error: 'Contato não encontrado.' });

  const { tipo, finalidade, origem, observacao } = req.body || {};
  try {
    const id = await consent.registrar({
      contactId: contato.id,
      tipo,
      finalidade,
      origem: origem || 'registro manual pelo operador no painel',
      observacao,
      usuarioId: req.user && req.user.id,
    });
    res.status(201).json({ id, elegivel: await consent.estaElegivel(contato.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
