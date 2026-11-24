(function () {
  const STORAGE_KEY = 'crm-theme';

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function getStoredTheme() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  // Aplica o tema o quanto antes (antes do body renderizar) pra evitar flash do tema errado.
  const initialTheme = getStoredTheme() || (systemPrefersDark() ? 'dark' : 'light');
  applyTheme(initialTheme);

  function createToggleButton() {
    const btn = document.createElement('button');
    btn.id = 'theme-toggle-btn';
    btn.type = 'button';
    btn.title = 'Trocar tema claro/escuro';

    function updateIcon() {
      const current = document.documentElement.getAttribute('data-theme');
      btn.textContent = current === 'dark' ? '☀️' : '🌙';
    }

    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem(STORAGE_KEY, next);
      updateIcon();
    });

    updateIcon();
    document.body.appendChild(btn);
  }

  if (document.body) {
    createToggleButton();
  } else {
    document.addEventListener('DOMContentLoaded', createToggleButton);
  }
})();
