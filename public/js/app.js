const STATUS_LABELS = {
  novo: 'Novo',
  em_conversa: 'Em conversa',
  orcamento_enviado: 'Orçamento enviado',
  fechado: 'Fechado',
  perdido: 'Perdido',
};

let conversations = [];
let activeConversationId = null;
let currentUser = null;
let teamUsers = [];

const listEl = document.getElementById('conversation-list');
const filterStatus = document.getElementById('filter-status');
const filterPlatform = document.getElementById('filter-platform');
const filterAssigned = document.getElementById('filter-assigned');
const threadAssignment = document.getElementById('thread-assignment');
const threadEmpty = document.getElementById('thread-empty');
const threadView = document.getElementById('thread-view');
const threadName = document.getElementById('thread-name');
const threadPlatform = document.getElementById('thread-platform');
const threadTags = document.getElementById('thread-tags');
const threadStatus = document.getElementById('thread-status');
const threadMessages = document.getElementById('thread-messages');
const replyForm = document.getElementById('reply-form');
const replyText = document.getElementById('reply-text');
const notesList = document.getElementById('notes-list');
const noteForm = document.getElementById('note-form');
const noteBody = document.getElementById('note-body');

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderConversationList() {
  const statusFilter = filterStatus.value;
  const platformFilter = filterPlatform.value;

  const assignedFilter = currentUser && currentUser.role === 'admin' ? filterAssigned.value : 'all';

  const filtered = conversations.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    if (platformFilter && c.platform !== platformFilter) return false;
    if (assignedFilter === 'mine' && c.assigned_user_id !== currentUser.id) return false;
    if (assignedFilter === 'unassigned' && c.assigned_user_id !== null) return false;
    return true;
  });

  listEl.innerHTML = '';
  for (const c of filtered) {
    const li = document.createElement('li');
    li.className = 'conversation-item' + (c.id === activeConversationId ? ' active' : '');
    li.style.borderLeft = `4px solid ${c.assigned_user_color || 'transparent'}`;
    li.innerHTML = `
      <div class="row1">
        <span class="name">${c.display_name || c.phone || 'Sem nome'}</span>
        <span class="time">${formatTime(c.last_message_at)}</span>
      </div>
      <div class="meta">
        <span class="badge ${c.platform}">${c.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram'}</span>
        <span class="status-pill ${c.status}">${STATUS_LABELS[c.status]}</span>
        ${c.assigned_user_name ? `<span class="assignee-chip" style="background:${c.assigned_user_color}">${escapeHtml(c.assigned_user_name)}</span>` : ''}
        ${c.unread_count > 0 ? `<span class="unread-dot">${c.unread_count}</span>` : ''}
      </div>
    `;
    li.addEventListener('click', () => openConversation(c.id));
    listEl.appendChild(li);
  }
}

async function loadConversations() {
  conversations = await api.get('/api/conversations');
  renderConversationList();
}

async function openConversation(id) {
  activeConversationId = id;
  renderConversationList();

  const conversation = await api.get(`/api/conversations/${id}`);
  const messages = await api.get(`/api/conversations/${id}/messages`);

  threadEmpty.classList.add('hidden');
  threadView.classList.remove('hidden');

  threadName.textContent = conversation.display_name || conversation.phone || 'Sem nome';
  threadPlatform.textContent = conversation.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram';
  threadPlatform.className = `badge ${conversation.platform}`;

  renderThreadTags(conversation.tags || []);
  renderThreadAssignment(conversation);

  threadStatus.innerHTML = Object.entries(STATUS_LABELS)
    .map(([value, label]) => `<option value="${value}" ${value === conversation.status ? 'selected' : ''}>${label}</option>`)
    .join('');

  renderMessages(messages);
  renderNotes(conversation.notes || []);

  const local = conversations.find((c) => c.id === id);
  if (local) local.unread_count = 0;
  renderConversationList();
}

async function refreshActiveThreadMeta() {
  if (!activeConversationId) return;
  const conversation = await api.get(`/api/conversations/${activeConversationId}`);
  renderThreadTags(conversation.tags || []);
  renderThreadAssignment(conversation);
  threadStatus.value = conversation.status;
  const local = conversations.find((c) => c.id === activeConversationId);
  if (local) local.status = conversation.status;
}

function renderMessages(messages) {
  threadMessages.innerHTML = '';
  for (const m of messages) {
    appendMessage(m, false);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;
}

// Mídia sem link: mostra o que chegou em vez de um balão vazio.
const ROTULO_MIDIA = {
  audio: '🎤 Áudio', image: '🖼️ Imagem', video: '🎬 Vídeo',
  document: '📄 Documento', sticker: 'Figurinha', location: '📍 Localização', reaction: 'Reação',
};

function appendMessage(m, scroll = true) {
    // O painel insere a mensagem ao enviar e o SSE a entrega de novo: ignora a repetida.
  if (m.id && threadMessages.querySelector(`[data-msg-id="${m.id}"]`)) return;
  const div = document.createElement('div');
  if (m.id) div.dataset.msgId = m.id;
  div.className = `message-bubble ${m.direction}`;
  div.innerHTML = `
    ${m.origin === 'ai' ? '<span class="tag-chip" style="background:#6b5ce0">🤖 IA</span>' : ''}
    ${m.media_url ? `<div><a href="${m.media_url}" target="_blank" rel="noopener">Ver mídia</a></div>` : ''}
    ${!m.content && !m.media_url && ROTULO_MIDIA[m.message_type] ? `<div><em>${ROTULO_MIDIA[m.message_type]}</em></div>` : ''}
    ${m.content ? `<div>${escapeHtml(m.content)}</div>` : ''}
    <span class="time">${formatTime(m.created_at) || 'agora'}</span>
  `;
  threadMessages.appendChild(div);
  if (scroll) threadMessages.scrollTop = threadMessages.scrollHeight;
}

function renderNotes(notes) {
  notesList.innerHTML = '';
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n.body;
    notesList.appendChild(li);
  }
}

async function assignConversation(id, userId) {
  await api.patch(`/api/conversations/${id}/assign`, { user_id: userId });
  const local = conversations.find((c) => c.id === id);
  if (local) local.assigned_user_id = userId;
}

function renderThreadAssignment(conversation) {
  const badge = conversation.assigned_user_name
    ? `<span class="assignee-chip" style="background:${conversation.assigned_user_color}">${escapeHtml(conversation.assigned_user_name)}</span>`
    : '';

  if (currentUser.role === 'admin') {
    const options = ['<option value="">Não atribuída</option>']
      .concat(
        teamUsers
          .filter((u) => u.is_active)
          .map((u) => `<option value="${u.id}" ${conversation.assigned_user_id === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`)
      )
      .join('');
    threadAssignment.innerHTML = `${badge}<select id="assign-select">${options}</select>`;
    document.getElementById('assign-select').addEventListener('change', async (e) => {
      const value = e.target.value ? Number(e.target.value) : null;
      try {
        await assignConversation(conversation.id, value);
        await refreshActiveThreadMeta();
      } catch (err) {
        alert(err.message);
      }
    });
  } else if (conversation.assigned_user_id === null) {
    threadAssignment.innerHTML = `<button type="button" id="claim-btn">Pegar conversa</button>`;
    document.getElementById('claim-btn').addEventListener('click', async () => {
      try {
        await assignConversation(conversation.id, currentUser.id);
        openConversation(conversation.id);
      } catch (err) {
        alert(err.message);
      }
    });
  } else {
    threadAssignment.innerHTML = badge;
  }
}

function renderThreadTags(tags) {
  threadTags.innerHTML = tags
    .map((t) => `<span class="tag-chip" style="background:${t.color}">${escapeHtml(t.name)}</span>`)
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

filterStatus.addEventListener('change', renderConversationList);
filterPlatform.addEventListener('change', renderConversationList);
filterAssigned.addEventListener('change', renderConversationList);

threadStatus.addEventListener('change', async () => {
  if (!activeConversationId) return;
  await api.patch(`/api/conversations/${activeConversationId}`, { status: threadStatus.value });
  const local = conversations.find((c) => c.id === activeConversationId);
  if (local) local.status = threadStatus.value;
  renderConversationList();
});

replyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = replyText.value.trim();
  if (!text || !activeConversationId) return;
  replyText.value = '';
  try {
    const message = await api.post(`/api/conversations/${activeConversationId}/messages`, { text });
    appendMessage(message);
  } catch (err) {
    alert(err.message);
  }
});

noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = noteBody.value.trim();
  if (!body || !activeConversationId) return;
  noteBody.value = '';
  const note = await api.post(`/api/conversations/${activeConversationId}/notes`, { body });
  const li = document.createElement('li');
  li.textContent = note.body;
  notesList.prepend(li);
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.post('/api/logout');
  window.location.href = '/login.html';
});

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.conversation_id === activeConversationId) {
      appendMessage(msg);
    }
    loadConversations();
  });
  source.addEventListener('conversation_updated', (e) => {
    loadConversations();
    const data = JSON.parse(e.data);
    if (data.conversation_id === activeConversationId) {
      refreshActiveThreadMeta();
    }
  });
  source.onerror = () => {
    // EventSource reconecta sozinho.
  };
}

async function init() {
  const session = await fetch('/api/session').then((r) => r.json());
  if (!session.authenticated) {
    window.location.href = '/login.html';
    return;
  }
  currentUser = session.user;
  document.getElementById('current-user-name').textContent = currentUser.name;

  if (currentUser.role === 'admin') {
    document.getElementById('nav-flows-link').classList.remove('hidden');
    document.getElementById('nav-users-link').classList.remove('hidden');
    document.getElementById('nav-marketing-link').classList.remove('hidden');
    document.getElementById('filter-assignment').classList.remove('hidden');
    teamUsers = await api.get('/api/users');
  }

  document.getElementById('app').classList.remove('hidden');
  await loadConversations();
  connectEvents();

  // Link vindo da ficha do contato (marketing): /?conversa=ID abre a conversa.
  const alvo = Number(new URLSearchParams(window.location.search).get('conversa'));
  if (alvo) {
    history.replaceState(null, '', window.location.pathname);
    openConversation(alvo);
  }
}

init();
