const api = {
  async get(path) {
    const res = await fetch(path);
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(`GET ${path} falhou: ${res.status}`);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `POST ${path} falhou: ${res.status}`);
    }
    return res.json();
  },
  async patch(path, body) {
    const res = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `PATCH ${path} falhou: ${res.status}`);
    }
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `PUT ${path} falhou: ${res.status}`);
    }
    return res.json();
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (res.status === 401) { window.location.href = '/login.html'; throw new Error('unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `DELETE ${path} falhou: ${res.status}`);
    }
    return res.json();
  },
};
