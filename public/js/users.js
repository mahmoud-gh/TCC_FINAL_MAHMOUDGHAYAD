function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

async function loadUsers() {
  const users = await api.get('/api/users');
  const listEl = document.getElementById('user-list');
  listEl.innerHTML = '';
  for (const user of users) {
    const li = document.createElement('li');
    li.className = 'user-row';
    li.innerHTML = `
      <div class="user-row-main">
        <input type="color" class="color-input" data-id="${user.id}" value="${user.color}" title="Cor do usuário" />
        <span class="flow-name">${escapeHtml(user.name)} <span class="flow-meta">(${escapeHtml(user.username)})</span></span>
        <span class="flow-meta">${user.role === 'admin' ? 'Administrador' : 'Atendente'}</span>
        <span class="${user.is_active ? 'flow-active-badge' : 'flow-inactive-badge'}">${user.is_active ? 'Ativo' : 'Inativo'}</span>
        <button type="button" class="password-btn" data-id="${user.id}">Trocar senha</button>
        <button type="button" class="toggle-btn" data-id="${user.id}" data-active="${user.is_active}">${user.is_active ? 'Desativar' : 'Reativar'}</button>
      </div>
      <form class="password-form hidden" data-id="${user.id}">
        <input type="password" placeholder="Nova senha" minlength="4" required />
        <button type="submit">Salvar senha</button>
        <button type="button" class="password-cancel">Cancelar</button>
      </form>
    `;
    listEl.appendChild(li);
  }

  listEl.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.active === '1' ? 'deactivate' : 'activate';
      try {
        await api.patch(`/api/users/${btn.dataset.id}/${action}`);
        loadUsers();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll('.color-input').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api.patch(`/api/users/${input.dataset.id}`, { color: input.value });
      } catch (err) {
        alert(err.message);
      }
    });
  });

  listEl.querySelectorAll('.password-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = listEl.querySelector(`.password-form[data-id="${btn.dataset.id}"]`);
      form.classList.remove('hidden');
      form.querySelector('input').focus();
    });
  });

  listEl.querySelectorAll('.password-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.password-form').classList.add('hidden');
    });
  });

  listEl.querySelectorAll('.password-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.querySelector('input').value;
      try {
        await api.patch(`/api/users/${form.dataset.id}`, { password });
        form.classList.add('hidden');
        form.reset();
        alert('Senha atualizada.');
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('new-user-btn').addEventListener('click', () => {
  document.getElementById('new-user-form').classList.remove('hidden');
});

document.getElementById('new-user-cancel').addEventListener('click', () => {
  document.getElementById('new-user-form').classList.add('hidden');
});

document.getElementById('new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value;
  const name = document.getElementById('new-name').value.trim();
  const role = document.getElementById('new-role').value;

  try {
    await api.post('/api/users', { username, password, name, role });
    document.getElementById('new-user-form').reset();
    document.getElementById('new-user-form').classList.add('hidden');
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

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
  await loadUsers();
})();
