const express = require('express');
const db = require('../db');

const router = express.Router();

const listStmt = db.prepare(`
  SELECT id, name, is_active, trigger_type, updated_at FROM flows ORDER BY updated_at DESC
`);
const getStmt = db.prepare(`SELECT * FROM flows WHERE id = ?`);
const insertStmt = db.prepare(`
  INSERT INTO flows (name, trigger_type, graph_json) VALUES (?, 'first_message', ?)
`);
const updateStmt = db.prepare(`
  UPDATE flows SET name = ?, graph_json = ?, updated_at = now() WHERE id = ?
`);
const activateStmt = db.prepare(`
  UPDATE flows SET is_active = 1, updated_at = now() WHERE id = ?
`);
const deactivateOthersStmt = db.prepare(`
  UPDATE flows SET is_active = 0, updated_at = now() WHERE id != ? AND trigger_type = ?
`);
const deactivateStmt = db.prepare(`
  UPDATE flows SET is_active = 0, updated_at = now() WHERE id = ?
`);
const deleteStmt = db.prepare(`DELETE FROM flows WHERE id = ?`);
const deleteRunEventsStmt = db.prepare(`
  DELETE FROM flow_run_events WHERE flow_run_id IN (SELECT id FROM flow_runs WHERE flow_id = ?)
`);
const deleteRunsStmt = db.prepare(`DELETE FROM flow_runs WHERE flow_id = ?`);
const statsStmt = db.prepare(`
  SELECT fre.node_id, fre.event, fre.branch_output, COUNT(*) AS count
  FROM flow_run_events fre
  JOIN flow_runs fr ON fr.id = fre.flow_run_id
  WHERE fr.flow_id = ?
  GROUP BY fre.node_id, fre.event, fre.branch_output
`);

function minimalGraph() {
  return {
    drawflow: {
      Home: {
        data: {
          1: {
            id: 1,
            name: 'trigger',
            data: {},
            class: 'trigger',
            html: '',
            typenode: false,
            inputs: {},
            outputs: { output_1: { connections: [] } },
            pos_x: 60,
            pos_y: 60,
          },
        },
      },
    },
  };
}

function validateGraph(graph) {
  const nodes = Object.values(
    (graph.drawflow && graph.drawflow.Home && graph.drawflow.Home.data) || {}
  );
  const triggers = nodes.filter((n) => n.name === 'trigger');
  if (triggers.length !== 1) {
    return 'O fluxo precisa ter exatamente um nó de gatilho (trigger).';
  }
  for (const node of nodes) {
    if (node.name === 'send_message') {
      const buttons = (node.data && node.data.buttons) || [];
      const ids = buttons.map((b) => b.id);
      if (new Set(ids).size !== ids.length) {
        return `Nó de mensagem (id ${node.id}) tem botões com ids duplicados.`;
      }
    }
  }
  return null;
}

router.get('/', async (req, res) => {
  res.json(await listStmt.all());
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name é obrigatório.' });
  const result = await insertStmt.run(name, JSON.stringify(minimalGraph()));
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

router.get('/:id', async (req, res) => {
  const flow = await getStmt.get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' });
  res.json({ ...flow, graph_json: JSON.parse(flow.graph_json) });
});

router.put('/:id', async (req, res) => {
  const flow = await getStmt.get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' });

  const { name, graph_json: graphJson } = req.body || {};
  if (!name || !graphJson) {
    return res.status(400).json({ error: 'name e graph_json são obrigatórios.' });
  }

  const validationError = validateGraph(graphJson);
  if (validationError) return res.status(400).json({ error: validationError });

  await updateStmt.run(name, JSON.stringify(graphJson), req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/activate', async (req, res) => {
  const flow = await getStmt.get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' });

  db.exec('BEGIN');
  try {
    await deactivateOthersStmt.run(req.params.id, flow.trigger_type);
    await activateStmt.run(req.params.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

router.patch('/:id/deactivate', async (req, res) => {
  await deactivateStmt.run(req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  db.exec('BEGIN');
  try {
    await deleteRunEventsStmt.run(req.params.id);
    await deleteRunsStmt.run(req.params.id);
    await deleteStmt.run(req.params.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

router.get('/:id/stats', async (req, res) => {
  res.json(await statsStmt.all(req.params.id));
});

module.exports = router;
