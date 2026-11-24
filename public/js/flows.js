const STATUS_OPTIONS = ['novo', 'em_conversa', 'orcamento_enviado', 'fechado', 'perdido'];
const NODE_LABELS = {
  trigger: 'Início (gatilho)',
  send_message: 'Enviar mensagem',
  pause: 'Pausar',
  create_lead: 'Criar lead',
  stop_bot: 'Parar robô',
};

const NODE_DEFAULTS = {
  trigger: {},
  send_message: { message_kind: 'text_only', body_text: 'Olá! Em que posso ajudar?', list_button_label: 'Escolher', no_reply_timeout_minutes: 30, buttons: [] },
  pause: { duration_seconds: 900 },
  create_lead: { tag_ids: [], set_status: '', assigned_user_id: null },
  stop_bot: {},
};

let editor = null;
let currentFlowId = null;
let currentEditingNodeId = null;
let availableTags = [];
let availableUsers = [];
let statsVisible = false;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------- View switching ----------

function showListView() {
  document.getElementById('flow-list-view').classList.remove('hidden');
  document.getElementById('flow-editor-view').classList.add('hidden');
  currentFlowId = null;
}

function showEditorView() {
  document.getElementById('flow-list-view').classList.add('hidden');
  document.getElementById('flow-editor-view').classList.remove('hidden');
}

// ---------- Flow list ----------

async function loadFlowList() {
  const flows = await api.get('/api/flows');
  const listEl = document.getElementById('flow-list');
  listEl.innerHTML = '';
  for (const flow of flows) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="flow-name">${escapeHtml(flow.name)}</span>
      <span class="flow-meta">Atualizado ${new Date(flow.updated_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR')}</span>
      <span class="${flow.is_active ? 'flow-active-badge' : 'flow-inactive-badge'}">${flow.is_active ? 'Ativo' : 'Inativo'}</span>
    `;
    li.addEventListener('click', () => openEditor(flow.id));
    listEl.appendChild(li);
  }
}

document.getElementById('new-flow-btn').addEventListener('click', () => {
  document.getElementById('new-flow-form').classList.remove('hidden');
  document.getElementById('new-flow-name').focus();
});

document.getElementById('new-flow-cancel').addEventListener('click', () => {
  document.getElementById('new-flow-form').classList.add('hidden');
  document.getElementById('new-flow-name').value = '';
});

document.getElementById('new-flow-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-flow-name').value.trim();
  if (!name) return;
  const result = await api.post('/api/flows', { name });
  document.getElementById('new-flow-name').value = '';
  document.getElementById('new-flow-form').classList.add('hidden');
  openEditor(result.id);
});

document.getElementById('back-to-list').addEventListener('click', () => {
  showListView();
  loadFlowList();
});

// ---------- Node rendering ----------

function outputsCountFor(name, data) {
  if (name === 'send_message') {
    const kind = (data && data.message_kind) || 'text_only';
    if (kind === 'text_only') return 2;
    return 3 + ((data && data.buttons) || []).length;
  }
  if (name === 'stop_bot') return 0;
  return 1;
}

function inputsCountFor(name) {
  return name === 'trigger' ? 0 : 1;
}

function renderNodeHtml(name, data) {
  data = data || {};
  switch (name) {
    case 'trigger':
      return `
        <div class="flow-node flow-node-trigger">
          <div class="flow-node-title">🚀 Início</div>
          <div class="flow-node-body">Primeira mensagem de um contato novo</div>
        </div>`;
    case 'send_message': {
      const buttons = data.buttons || [];
      const preview = escapeHtml((data.body_text || '(sem texto)').slice(0, 90));
      const chips = buttons.map((b) => `<span class="chip">${escapeHtml(b.label)}</span>`).join('');
      return `
        <div class="flow-node flow-node-message">
          <div class="flow-node-header">
            <span class="flow-node-title">💬 Enviar mensagem</span>
            <button class="node-gear" type="button">⚙</button>
          </div>
          <div class="flow-node-body">${preview}</div>
          ${chips ? `<div class="flow-node-chips">${chips}</div>` : ''}
          <div class="flow-node-footer">
            <span class="flow-node-outcome">Outra resposta</span>
            <span class="flow-node-outcome">Sem resposta</span>
            <span class="flow-node-outcome">Falha</span>
          </div>
        </div>`;
    }
    case 'pause': {
      const seconds = Number(data.duration_seconds) || 0;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return `
        <div class="flow-node flow-node-pause">
          <div class="flow-node-header">
            <span class="flow-node-title">⏱ Pausar</span>
            <button class="node-gear" type="button">⚙</button>
          </div>
          <div class="flow-node-body">${h}h ${m}min ${s}s</div>
        </div>`;
    }
    case 'create_lead': {
      const tagCount = (data.tag_ids || []).length;
      const assignedUser = availableUsers.find((u) => u.id === data.assigned_user_id);
      return `
        <div class="flow-node flow-node-lead">
          <div class="flow-node-header">
            <span class="flow-node-title">🏷 Criar lead</span>
            <button class="node-gear" type="button">⚙</button>
          </div>
          <div class="flow-node-body">${tagCount} tag(s)${data.set_status ? ' · status: ' + escapeHtml(data.set_status) : ''}${assignedUser ? ' · atribuir: ' + escapeHtml(assignedUser.name) : ''}</div>
        </div>`;
    }
    case 'stop_bot':
      return `
        <div class="flow-node flow-node-stop">
          <div class="flow-node-title">⏹ Parar robô</div>
        </div>`;
    default:
      return `<div class="flow-node">?</div>`;
  }
}

function hasTriggerNode() {
  const data = (editor.drawflow.drawflow.Home && editor.drawflow.drawflow.Home.data) || {};
  return Object.values(data).some((n) => n.name === 'trigger');
}

function addNodeToCanvas(name, posX, posY) {
  if (name === 'trigger' && hasTriggerNode()) {
    alert('Só pode haver um nó de início por fluxo.');
    return;
  }
  const data = JSON.parse(JSON.stringify(NODE_DEFAULTS[name] || {}));
  const html = renderNodeHtml(name, data);
  editor.addNode(name, inputsCountFor(name), outputsCountFor(name, data), posX, posY, name, data, html);
}

function refreshNodeContent(nodeId) {
  const node = editor.getNodeFromId(nodeId);
  const el = document.querySelector(`#node-${nodeId} .drawflow_content_node`);
  if (el) el.innerHTML = renderNodeHtml(node.name, node.data);
}

function setOutputCount(nodeId, targetCount) {
  let node = editor.getNodeFromId(nodeId);
  let current = Object.keys(node.outputs).length;
  while (current < targetCount) {
    editor.addNodeOutput(nodeId);
    current++;
  }
  while (current > targetCount) {
    editor.removeNodeOutput(nodeId, 'output_' + current);
    current--;
  }
}

// ---------- Node side panel ----------

function renderNodeForm(name, data) {
  data = data || {};
  switch (name) {
    case 'trigger':
      return `<p>Dispara automaticamente quando um contato novo manda a primeira mensagem (WhatsApp ou Instagram).</p>`;
    case 'send_message':
      return `
        <div class="field">
          <label>Tipo de mensagem</label>
          <select id="f-message-kind">
            <option value="text_only" ${data.message_kind === 'text_only' ? 'selected' : ''}>Somente texto (avança sozinho)</option>
            <option value="buttons" ${data.message_kind === 'buttons' ? 'selected' : ''}>Botões (até 3)</option>
            <option value="list" ${data.message_kind === 'list' ? 'selected' : ''}>Lista (até 10)</option>
          </select>
        </div>
        <div class="field">
          <label>Texto da mensagem</label>
          <textarea id="f-body-text">${escapeHtml(data.body_text || '')}</textarea>
        </div>
        <div class="field" id="f-list-label-field" style="${data.message_kind === 'list' ? '' : 'display:none'}">
          <label>Texto do botão da lista</label>
          <input type="text" id="f-list-label" value="${escapeHtml(data.list_button_label || 'Escolher')}" />
        </div>
        <div class="field" id="f-timeout-field" style="${data.message_kind !== 'text_only' ? '' : 'display:none'}">
          <label>Tempo sem resposta até desistir (minutos)</label>
          <input type="number" id="f-timeout" min="1" value="${Number(data.no_reply_timeout_minutes) || 30}" />
        </div>
        <div class="field" id="f-buttons-field" style="${data.message_kind !== 'text_only' ? '' : 'display:none'}">
          <label>Botões</label>
          <div id="f-buttons-list"></div>
          <button type="button" id="f-add-button">+ Adicionar botão</button>
        </div>
      `;
    case 'pause':
      return `
        <div class="field">
          <label>Duração da pausa</label>
          <div style="display:flex; gap:6px;">
            <input type="number" id="f-hours" min="0" style="width:70px" value="${Math.floor((Number(data.duration_seconds) || 0) / 3600)}" /> h
            <input type="number" id="f-minutes" min="0" style="width:70px" value="${Math.floor(((Number(data.duration_seconds) || 0) % 3600) / 60)}" /> min
            <input type="number" id="f-seconds" min="0" style="width:70px" value="${(Number(data.duration_seconds) || 0) % 60}" /> seg
          </div>
        </div>
      `;
    case 'create_lead': {
      const selected = new Set(data.tag_ids || []);
      const tagCheckboxes = availableTags
        .map(
          (t) => `<label><input type="checkbox" value="${t.id}" ${selected.has(t.id) ? 'checked' : ''} /> ${escapeHtml(t.name)}</label>`
        )
        .join('');
      const statusOptions = STATUS_OPTIONS
        .map((s) => `<option value="${s}" ${data.set_status === s ? 'selected' : ''}>${s}</option>`)
        .join('');
      const userOptions = availableUsers
        .filter((u) => u.is_active)
        .map((u) => `<option value="${u.id}" ${data.assigned_user_id === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`)
        .join('');
      return `
        <div class="field">
          <label>Aplicar tags</label>
          <div class="tag-checkbox-list" id="f-tags">${tagCheckboxes || '<span>Nenhuma tag cadastrada ainda.</span>'}</div>
        </div>
        <div class="field">
          <label>Mudar status da conversa</label>
          <select id="f-set-status">
            <option value="">(não mudar)</option>
            ${statusOptions}
          </select>
        </div>
        <div class="field">
          <label>Atribuir a</label>
          <select id="f-assign-user">
            <option value="">(não atribuir)</option>
            ${userOptions}
          </select>
          <span style="font-size:0.7rem">Só atribui se a conversa ainda estiver livre — não rouba de quem já pegou.</span>
        </div>
      `;
    }
    case 'stop_bot':
      return `<p>Encerra a automação para esta conversa — a partir daqui é atendimento humano normal.</p>`;
    default:
      return '';
  }
}

function renderButtonRows(buttons) {
  const container = document.getElementById('f-buttons-list');
  if (!container) return;
  container.innerHTML = buttons
    .map(
      (b, i) => `
      <div class="button-editor-row" data-index="${i}">
        <input type="text" class="btn-label" placeholder="Rótulo" value="${escapeHtml(b.label || '')}" />
        <input type="text" class="btn-synonyms" placeholder="Sinônimos (vírgula)" value="${escapeHtml((b.synonyms || []).join(', '))}" />
        <button type="button" class="remove-btn" data-index="${i}">✕</button>
      </div>`
    )
    .join('');

  container.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      panelButtonsState.splice(idx, 1);
      renderButtonRows(panelButtonsState);
    });
  });
}

let panelButtonsState = [];

function wireNodeForm(name, data) {
  if (name !== 'send_message') return;

  panelButtonsState = JSON.parse(JSON.stringify(data.buttons || []));
  renderButtonRows(panelButtonsState);

  const kindSelect = document.getElementById('f-message-kind');
  kindSelect.addEventListener('change', () => {
    const kind = kindSelect.value;
    document.getElementById('f-list-label-field').style.display = kind === 'list' ? '' : 'none';
    document.getElementById('f-timeout-field').style.display = kind !== 'text_only' ? '' : 'none';
    document.getElementById('f-buttons-field').style.display = kind !== 'text_only' ? '' : 'none';
  });

  document.getElementById('f-add-button').addEventListener('click', () => {
    const kind = kindSelect.value;
    const max = kind === 'list' ? 10 : 3;
    if (panelButtonsState.length >= max) {
      alert(`Máximo de ${max} botões para o tipo "${kind === 'list' ? 'lista' : 'botões'}".`);
      return;
    }
    panelButtonsState.push({ id: `btn_${Date.now()}_${panelButtonsState.length}`, label: '', synonyms: [] });
    renderButtonRows(panelButtonsState);
  });
}

function collectNodeData(name) {
  switch (name) {
    case 'trigger':
    case 'stop_bot':
      return {};
    case 'send_message': {
      const rows = document.querySelectorAll('#f-buttons-list .button-editor-row');
      const buttons = panelButtonsState.map((b, i) => {
        const row = rows[i];
        const label = row ? row.querySelector('.btn-label').value.trim() : b.label;
        const synonymsRaw = row ? row.querySelector('.btn-synonyms').value : (b.synonyms || []).join(', ');
        const synonyms = synonymsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        return { id: b.id, label, synonyms };
      });
      return {
        message_kind: document.getElementById('f-message-kind').value,
        body_text: document.getElementById('f-body-text').value,
        list_button_label: document.getElementById('f-list-label').value,
        no_reply_timeout_minutes: Number(document.getElementById('f-timeout').value) || 30,
        buttons,
      };
    }
    case 'pause': {
      const h = Number(document.getElementById('f-hours').value) || 0;
      const m = Number(document.getElementById('f-minutes').value) || 0;
      const s = Number(document.getElementById('f-seconds').value) || 0;
      return { duration_seconds: h * 3600 + m * 60 + s };
    }
    case 'create_lead': {
      const tagIds = Array.from(document.querySelectorAll('#f-tags input[type=checkbox]:checked')).map((cb) => Number(cb.value));
      const assignedUserId = document.getElementById('f-assign-user').value;
      return {
        tag_ids: tagIds,
        set_status: document.getElementById('f-set-status').value || null,
        assigned_user_id: assignedUserId ? Number(assignedUserId) : null,
      };
    }
    default:
      return {};
  }
}

function openNodePanel(nodeId) {
  currentEditingNodeId = nodeId;
  const node = editor.getNodeFromId(nodeId);
  document.getElementById('node-panel-title').textContent = NODE_LABELS[node.name] || node.name;
  document.getElementById('node-panel-body').innerHTML = renderNodeForm(node.name, node.data);
  wireNodeForm(node.name, node.data);
  document.getElementById('node-panel').classList.remove('hidden');
}

function closeNodePanel() {
  currentEditingNodeId = null;
  document.getElementById('node-panel').classList.add('hidden');
}

document.getElementById('node-panel-close').addEventListener('click', closeNodePanel);

document.getElementById('node-panel-delete').addEventListener('click', () => {
  if (currentEditingNodeId == null) return;
  if (!confirm('Excluir este nó?')) return;
  editor.removeNodeId('node-' + currentEditingNodeId);
  closeNodePanel();
});

document.getElementById('node-panel-save').addEventListener('click', () => {
  if (currentEditingNodeId == null) return;
  const node = editor.getNodeFromId(currentEditingNodeId);
  const newData = collectNodeData(node.name);
  const targetOutputs = outputsCountFor(node.name, newData);
  setOutputCount(currentEditingNodeId, targetOutputs);
  editor.updateNodeDataFromId(currentEditingNodeId, newData);
  refreshNodeContent(currentEditingNodeId);
  closeNodePanel();
});

// ---------- Canvas events (delegation) ----------

const drawflowEl = document.getElementById('drawflow');

drawflowEl.addEventListener('click', (e) => {
  const gear = e.target.closest('.node-gear');
  if (!gear) return;
  const nodeEl = e.target.closest('.drawflow-node');
  if (!nodeEl) return;
  const nodeId = nodeEl.id.replace('node-', '');
  openNodePanel(nodeId);
});

drawflowEl.addEventListener('dragover', (e) => e.preventDefault());

drawflowEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const nodeType = e.dataTransfer.getData('node-type');
  if (!nodeType) return;
  const rect = editor.precanvas.getBoundingClientRect();
  const posX = (e.clientX - rect.x) / editor.zoom;
  const posY = (e.clientY - rect.y) / editor.zoom;
  addNodeToCanvas(nodeType, posX, posY);
});

document.querySelectorAll('.palette-item').forEach((el) => {
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('node-type', el.dataset.node);
  });
});

// ---------- Editor lifecycle ----------

function initEditorInstance() {
  editor = new Drawflow(drawflowEl);
  editor.reroute = true;
  editor.start();
}

async function openEditor(flowId) {
  currentFlowId = flowId;
  const flow = await api.get(`/api/flows/${flowId}`);
  availableTags = await api.get('/api/conversations/tags');
  availableUsers = await api.get('/api/users');

  showEditorView();
  initEditorInstance();
  editor.import(flow.graph_json);

  const nodes = (flow.graph_json.drawflow.Home && flow.graph_json.drawflow.Home.data) || {};
  const maxId = Math.max(0, ...Object.keys(nodes).map(Number));
  editor.nodeId = maxId + 1;

  for (const nodeId of Object.keys(nodes)) {
    refreshNodeContent(nodeId);
  }

  document.getElementById('flow-name-input').value = flow.name;
  document.getElementById('flow-active-toggle').checked = !!flow.is_active;
  closeNodePanel();
  statsVisible = false;
  clearStatBadges();
}

document.getElementById('save-flow-btn').addEventListener('click', async () => {
  const name = document.getElementById('flow-name-input').value.trim();
  if (!name) { alert('Dê um nome ao fluxo.'); return; }
  const graphJson = editor.export();
  try {
    await api.put(`/api/flows/${currentFlowId}`, { name, graph_json: graphJson });
    alert('Fluxo salvo.');
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('flow-active-toggle').addEventListener('change', async (e) => {
  const action = e.target.checked ? 'activate' : 'deactivate';
  try {
    await api.patch(`/api/flows/${currentFlowId}/${action}`);
  } catch (err) {
    alert(err.message);
    e.target.checked = !e.target.checked;
  }
});

// ---------- Stats ----------

function clearStatBadges() {
  document.querySelectorAll('.flow-node-stat-badge').forEach((el) => el.remove());
}

document.getElementById('stats-toggle-btn').addEventListener('click', async () => {
  statsVisible = !statsVisible;
  clearStatBadges();
  if (!statsVisible || !currentFlowId) return;

  const stats = await api.get(`/api/flows/${currentFlowId}/stats`);
  const enteredByNode = {};
  for (const row of stats) {
    if (row.event === 'entered') {
      enteredByNode[row.node_id] = (enteredByNode[row.node_id] || 0) + row.count;
    }
  }
  const total = Math.max(1, ...Object.values(enteredByNode), 0);

  for (const [nodeId, count] of Object.entries(enteredByNode)) {
    const nodeEl = document.getElementById('node-' + nodeId);
    if (!nodeEl) continue;
    const pct = ((count / total) * 100).toFixed(1);
    const badge = document.createElement('div');
    badge.className = 'flow-node-stat-badge';
    badge.textContent = `Lançamentos: ${count} / ${pct}%`;
    badge.style.left = nodeEl.style.left;
    badge.style.top = nodeEl.style.top;
    drawflowEl.querySelector('.drawflow').appendChild(badge);
  }
});

// ---------- Init ----------

(async function init() {
  const session = await fetch('/api/session').then((r) => r.json());
  if (!session.authenticated) {
    window.location.href = '/login.html';
    return;
  }
  if (session.user.role !== 'admin') {
    window.location.href = '/index.html';
    return;
  }
  showListView();
  await loadFlowList();
})();
