/* Painel de marketing ativo — consome /api/campanhas, /api/segmentos,
   /api/modelos e /api/contatos. Sem build step, no mesmo padrão de public/js. */

const el = (sel) => document.querySelector(sel);
const els = (sel) => Array.from(document.querySelectorAll(sel));

let metadados = { atributos: [], operadores: [] };
let cacheSegmentos = [];
let cacheModelos = [];

function alerta(msg, tipo = 'ok') {
  const box = el('#mk-alert');
  box.textContent = msg;
  box.className = `mk-alert mk-alert-${tipo === 'erro' ? 'erro' : 'ok'}`;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 6000);
}

function pct(valor) {
  return `${((valor || 0) * 100).toFixed(1).replace('.', ',')}%`;
}

function segundos(valor) {
  if (valor == null) return '—';
  if (valor < 90) return `${valor.toFixed(0)} s`;
  if (valor < 5400) return `${(valor / 60).toFixed(1).replace('.', ',')} min`;
  return `${(valor / 3600).toFixed(1).replace('.', ',')} h`;
}

function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// ----------------------------------------------------------------- abas ----
els('.mk-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    els('.mk-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    els('.mk-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    carregarAba(tab.dataset.tab);
  });
});

function carregarAba(aba) {
  if (aba === 'campanhas') carregarCampanhas();
  if (aba === 'segmentos') carregarSegmentos();
  if (aba === 'modelos') carregarModelos();
  if (aba === 'contatos') carregarContatos();
  if (aba === 'metricas') carregarComparativo();
}

// ------------------------------------------------------------- contatos ----
let cacheContatos = [];
let filtroConsent = 'todos';

const ROTULO_CONSENT = {
  opt_in: { texto: 'opt-in', classe: 'mk-badge-ok' },
  opt_out: { texto: 'opt-out', classe: 'mk-badge-off' },
  nenhum: { texto: 'sem consentimento', classe: 'mk-badge-warn' },
};
const estadoConsent = (c) => (c.consentimento_atual === 'opt_in' || c.consentimento_atual === 'opt_out'
  ? c.consentimento_atual : 'nenhum');

// Datas do banco chegam em UTC sem fuso ("2026-11-07 23:49:47").
function quando(valor, { hora = true, curto = false } = {}) {
  if (!valor) return '—';
  const d = new Date(String(valor).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(valor) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return escapar(valor);
  if (curto) return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('pt-BR', hora
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Número de 14+ dígitos que não é BR/PY: é o código interno (LID) do WhatsApp.
const pareceLid = (n) => /^\d{14,}$/.test(n) && !/^(55|595)/.test(n);

function formatarTelefone(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  if (!d) return '—';
  if (pareceLid(d)) return 'oculto pelo WhatsApp';
  if (/^55\d{10,11}$/.test(d)) {
    const r = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${r.slice(0, r.length - 4)}-${r.slice(-4)}`;
  }
  if (/^595\d{9}$/.test(d)) return `+595 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  return `+${d}`;
}

function iniciais(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));
  if (!partes.length) return '#';
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

let cacheInteresses = [];
let filtroInteresse = '';
const interessesDe = (c) => String(c.interesse_declarado || '').split(',').map((t) => t.trim()).filter(Boolean);

async function carregarInteresses() {
  cacheInteresses = await api.get('/api/contatos/interesses');
  const dl = el('#dl-interesses');
  if (dl) dl.innerHTML = cacheInteresses.map((i) => `<option value="${escapar(i.nome)}">`).join('');
  return cacheInteresses;
}

async function carregarContatos() {
  const busca = el('#busca-contato').value.trim();
  [cacheContatos] = await Promise.all([
    api.get(`/api/contatos?busca=${encodeURIComponent(busca)}`),
    carregarInteresses(),
  ]);
  renderContatos();
}

function renderContatos() {
  const sel = el('#filtro-interesse');
  if (filtroInteresse && !cacheInteresses.some((i) => i.nome.toLowerCase() === filtroInteresse)) filtroInteresse = '';
  sel.innerHTML = `<option value="">Todos os interesses</option>${cacheInteresses.map((i) => `
    <option value="${escapar(i.nome.toLowerCase())}" ${filtroInteresse === i.nome.toLowerCase() ? 'selected' : ''}>
      ${escapar(i.nome)} (${i.total})</option>`).join('')}`;
  const base = filtroInteresse
    ? cacheContatos.filter((c) => interessesDe(c).some((n) => n.toLowerCase() === filtroInteresse))
    : cacheContatos;

  const contagem = { todos: base.length, opt_in: 0, nenhum: 0, opt_out: 0 };
  base.forEach((c) => { contagem[estadoConsent(c)] += 1; });
  const filtros = [['todos', 'Todos'], ['opt_in', 'Com opt-in'], ['nenhum', 'Sem consentimento'], ['opt_out', 'Opt-out']];
  el('#filtro-consent').innerHTML = filtros.map(([valor, rotulo]) => `
    <button type="button" class="fc-chip ${filtroConsent === valor ? 'is-active' : ''}" data-filtro="${valor}"
      aria-pressed="${filtroConsent === valor}">${rotulo} <span>${contagem[valor]}</span></button>`).join('');
  els('[data-filtro]').forEach((b) => b.addEventListener('click', () => {
    filtroConsent = b.dataset.filtro;
    renderContatos();
  }));

  const lista = base.filter((c) => filtroConsent === 'todos' || estadoConsent(c) === filtroConsent);
  el('#lista-contatos').innerHTML = lista.length
    ? lista.map((c) => {
      const r = ROTULO_CONSENT[estadoConsent(c)];
      const nome = c.display_name || formatarTelefone(c.phone) || `#${c.id}`;
      const detalhes = [
        formatarTelefone(c.phone),
        c.perfil && `perfil: ${escapar(c.perfil)}`,
        c.nivel_engajamento && `engajamento: ${c.nivel_engajamento === 'medio' ? 'médio' : escapar(c.nivel_engajamento)}`,
        c.ultima_interacao && `última interação: ${quando(c.ultima_interacao)}`,
      ].filter(Boolean).join(' · ');
      return `
      <div class="mk-card fc-item" data-ficha="${c.id}" tabindex="0" role="button"
        aria-label="Abrir ficha de ${escapar(nome)}">
        <div class="fc-avatar fc-avatar-sm" aria-hidden="true">${escapar(iniciais(c.display_name))}</div>
        <div class="fc-item-info">
          <div class="mk-card-title">${escapar(nome)}
            <span class="mk-badge ${r.classe}">${r.texto}</span></div>
          <div class="mk-card-meta">${detalhes}</div>
          ${interessesDe(c).length ? `<div class="fc-tags">${interessesDe(c).map((n) => `<span class="fc-tag">${escapar(n)}</span>`).join('')}</div>` : ''}
        </div>
        <span class="fc-item-abrir">Abrir ficha →</span>
      </div>`;
    }).join('')
    : `<p class="mk-dim">${cacheContatos.length ? 'Nenhum contato neste filtro.' : 'Nenhum contato encontrado.'}</p>`;

  els('[data-ficha]').forEach((card) => {
    card.addEventListener('click', () => abrirFicha(card.dataset.ficha));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrirFicha(card.dataset.ficha); }
    });
  });
}

el('#filtro-interesse').addEventListener('change', (ev) => {
  filtroInteresse = ev.target.value;
  renderContatos();
});
el('#abrir-interesses').addEventListener('click', () => abrirGerenciador());

el('#busca-contato').addEventListener('input', () => {
  clearTimeout(window.__buscaTimer);
  window.__buscaTimer = setTimeout(carregarContatos, 300);
});

// ---------------------------------------------- ficha do contato (modal) ----
const ficha = el('#ficha');
const fichaConteudo = el('#ficha-conteudo');
let fichaAtual = null;

const ORIGENS = {
  opt_in: [
    'respondeu aceitando pelo WhatsApp',
    'autorização verbal registrada no atendimento',
    'autorização presencial na loja',
    'formulário ou cadastro preenchido pelo cliente',
  ],
  opt_out: [
    'pediu pelo WhatsApp para não receber (SAIR/PARAR)',
    'solicitação verbal do titular',
    'solicitação por outro canal (e-mail, telefone)',
  ],
};
const STATUS_CONVERSA = {
  novo: 'Novo', em_conversa: 'Em conversa', orcamento_enviado: 'Orçamento enviado', fechado: 'Fechado', perdido: 'Perdido',
};
const SITUACAO_ENVIO = { enviado: 'enviado', falha: 'falhou', nao_elegivel: 'bloqueado (sem opt-in)' };
const QUEM = { in: 'Cliente', out: 'Atendente' };

ficha.addEventListener('click', (ev) => { if (ev.target === ficha) ficha.close(); });

async function abrirFicha(id, aviso) {
  if (!ficha.open) {
    fichaConteudo.innerHTML = '<div class="fc-carregando">Carregando ficha…</div>';
    ficha.showModal();
  }
  try {
    fichaAtual = await api.get(`/api/contatos/${id}`);
    renderFicha(aviso);
  } catch (err) {
    fichaConteudo.innerHTML = `
      <div class="fc-carregando">Não foi possível abrir a ficha: ${escapar(err.message)}
        <button class="mk-btn mk-btn-ghost mk-btn-sm" data-fechar>Fechar</button></div>`;
    fichaConteudo.querySelector('[data-fechar]').addEventListener('click', () => ficha.close());
  }
}

function blocoStatus(c) {
  const ultima = c.consentimentos[0];
  if (c.consentimento_atual === 'opt_in') {
    return `<div class="fc-status fc-status-ok"><strong>Opt-in ativo</strong>
      <span>Recebe campanhas desde ${quando(ultima.data_hora)} · ${escapar(ultima.origem)}</span></div>`;
  }
  if (c.consentimento_atual === 'opt_out') {
    return `<div class="fc-status fc-status-off"><strong>Opt-out</strong>
      <span>Pediu para não receber em ${quando(ultima.data_hora)} · nenhuma campanha é enviada</span></div>`;
  }
  return `<div class="fc-status fc-status-neutro"><strong>Sem consentimento</strong>
    <span>Não recebe campanhas. Registre o opt-in abaixo quando o cliente autorizar.</span></div>`;
}

function blocoConsentimento(c, tipo) {
  const opcoes = ORIGENS[tipo].map((o) => `<option>${escapar(o)}</option>`).join('');
  return `
    <form id="fc-form-consent" class="fc-form" novalidate>
      <div class="fc-seg" role="radiogroup" aria-label="Tipo de manifestação">
        <label><input type="radio" name="tipo" value="opt_in" ${tipo === 'opt_in' ? 'checked' : ''}>
          <span>Opt-in · aceita receber</span></label>
        <label><input type="radio" name="tipo" value="opt_out" ${tipo === 'opt_out' ? 'checked' : ''}>
          <span>Opt-out · não quer receber</span></label>
      </div>
      <label>Como o cliente se manifestou
        <select name="origem">${opcoes}<option value="outro">outro (descrever)</option></select></label>
      <label class="hidden" data-outro>Descreva a origem
        <input name="origem_outro" maxlength="200" placeholder="Ex.: respondeu à enquete do Instagram"></label>
      <label>Finalidade
        <input name="finalidade" value="${escapar(c.finalidade_padrao)}" maxlength="200"></label>
      <label><span>Observação ou evidência <span class="fc-opcional">opcional</span></span>
        <textarea name="observacao" rows="2" maxlength="500"
          placeholder="Ex.: mensagem de 07/11 às 20:49 dizendo “pode mandar as promoções”"></textarea></label>
      ${tipo === 'opt_in' ? `
      <label class="fc-check"><input type="checkbox" name="confirmo">
        <span>Confirmo que o próprio cliente autorizou receber mensagens de marketing pelo WhatsApp.</span></label>` : ''}
      ${c.consentimento_atual === tipo ? `<p class="fc-dica">Este contato já está com ${tipo === 'opt_in' ? 'opt-in' : 'opt-out'}.
        Registrar de novo só acrescenta uma entrada ao histórico.</p>` : ''}
      <div class="fc-form-acoes">
        <button class="mk-btn ${tipo === 'opt_out' ? 'fc-btn-perigo' : ''}" type="submit">
          Registrar ${tipo === 'opt_in' ? 'opt-in' : 'opt-out'}</button>
        <p class="fc-msg" role="status" aria-live="polite"></p>
      </div>
    </form>`;
}

function blocoHistorico(c) {
  if (!c.consentimentos.length) {
    return '<p class="mk-dim">Nenhuma manifestação registrada. Sem registro, o contato é tratado como sem consentimento.</p>';
  }
  return `<ol class="fc-timeline">${c.consentimentos.map((k) => `
    <li class="${k.tipo === 'opt_in' ? 'is-in' : 'is-out'}">
      <div class="fc-tl-top">
        <span class="mk-badge ${ROTULO_CONSENT[k.tipo].classe}">${ROTULO_CONSENT[k.tipo].texto}</span>
        <time>${quando(k.data_hora)}</time>
      </div>
      <div class="fc-tl-origem">${escapar(k.origem)}</div>
      <div class="mk-dim">Finalidade: ${escapar(k.finalidade)}${k.registrado_por_nome ? ` · registrado por ${escapar(k.registrado_por_nome)}` : ' · registro automático'}</div>
      ${k.observacao ? `<div class="fc-tl-obs">${escapar(k.observacao)}</div>` : ''}
    </li>`).join('')}</ol>`;
}

function blocoDados(c) {
  const eng = c.nivel_engajamento || '';
  const niveis = ['alto', 'medio', 'baixo'];
  return `
    <form id="fc-form-dados" class="fc-form fc-grid2">
      <label class="fc-span2">Nome <input name="display_name" value="${escapar(c.display_name || '')}" maxlength="120"></label>
      <label>Perfil <input name="perfil" value="${escapar(c.perfil || '')}" list="fc-perfis" maxlength="60"
        placeholder="varejo, atacado…"></label>
      <label>Nível de engajamento <select name="nivel_engajamento">
        <option value="">—</option>
        ${niveis.map((n) => `<option value="${n}" ${eng === n ? 'selected' : ''}>${n === 'medio' ? 'médio' : n}</option>`).join('')}
        ${eng && !niveis.includes(eng) ? `<option selected>${escapar(eng)}</option>` : ''}
      </select></label>
      <datalist id="fc-perfis"><option value="varejo"><option value="atacado"></datalist>
      <div class="fc-form-acoes fc-span2">
        <button class="mk-btn mk-btn-ghost" type="submit">Salvar dados</button>
        <p class="fc-msg" role="status" aria-live="polite"></p>
      </div>
    </form>
    <dl class="fc-dl">
      <dt>Telefone</dt><dd>${formatarTelefone(c.phone)}</dd>
      <dt>ID no WhatsApp</dt><dd><code>${escapar(c.platform_user_id)}</code>${pareceLid(c.platform_user_id) ? ' <span class="mk-dim">(código interno)</span>' : ''}</dd>
      <dt>Canal</dt><dd>${c.platform === 'instagram' ? 'Instagram' : 'WhatsApp'}</dd>
      <dt>Cadastrado em</dt><dd>${quando(c.created_at)}</dd>
      <dt>Última interação</dt><dd>${quando(c.ultima_interacao)}</dd>
      <dt>Atualizado em</dt><dd>${quando(c.updated_at)}</dd>
      ${c.anonimizado ? '<dt>LGPD</dt><dd>dados anonimizados</dd>' : ''}
    </dl>`;
}

function blocoAtividade(c) {
  const soma = (campo) => c.conversas.reduce((t, cv) => t + Number(cv[campo] || 0), 0);
  const enviadosOk = c.campanhas.filter((e) => e.situacao === 'enviado').length;
  const um = c.ultima_mensagem;
  const autor = um ? (um.direction === 'out' && (um.origin === 'bot' || um.origin === 'ai') ? 'Bot' : QUEM[um.direction]) : '';

  return `
    <div class="fc-kpis">
      <div><strong>${soma('recebidas')}</strong><span>recebidas</span></div>
      <div><strong>${soma('enviadas')}</strong><span>enviadas</span></div>
      <div><strong>${soma('do_bot')}</strong><span>pelo bot</span></div>
      <div><strong>${enviadosOk}</strong><span>campanhas</span></div>
    </div>
    ${um ? `<div class="fc-ultima"><div class="mk-dim">Última mensagem · ${autor} · ${quando(um.created_at)}</div>
      <div>${um.content ? escapar(um.content.length > 160 ? `${um.content.slice(0, 160)}…` : um.content) : `<em>${escapar(um.message_type)}</em>`}</div></div>` : ''}

    <h4>Conversas</h4>
    ${c.conversas.length ? `<ul class="fc-conversas">${c.conversas.map((cv) => `
      <li>
        <span class="fc-pill" style="--cor: var(--${cv.status}, var(--text-dim))">${STATUS_CONVERSA[cv.status] || cv.status}</span>
        <span class="fc-conv-info">${cv.recebidas} recebidas · ${cv.enviadas} enviadas
          <span class="mk-dim">· ${cv.atendente ? escapar(cv.atendente) : 'sem atendente'} · ${quando(cv.last_message_at, { curto: true })}</span></span>
        <a class="mk-btn mk-btn-ghost mk-btn-sm" href="/?conversa=${cv.id}">Abrir</a>
      </li>`).join('')}</ul>` : '<p class="mk-dim">Nenhuma conversa ainda.</p>'}

    <h4>Campanhas recebidas</h4>
    ${c.campanhas.length ? `<div class="fc-tabela"><table class="mk-table">
      <thead><tr><th>Campanha</th><th>Data</th><th>Resultado</th></tr></thead>
      <tbody>${c.campanhas.map((e) => `
        <tr>
          <td>${escapar(e.campanha)} <span class="mk-dim">· ${e.cenario === 'automatizado' ? 'automatizada' : 'manual'}</span></td>
          <td>${quando(e.data_hora_envio, { hora: false })}</td>
          <td>${resultadoEnvio(e)}</td>
        </tr>`).join('')}</tbody></table></div>`
    : '<p class="mk-dim">Nenhuma campanha enviada para este contato.</p>'}`;
}

// Chips do que aconteceu com o envio: entregue → lido → clique → resposta → conversão.
function resultadoEnvio(e) {
  if (e.situacao !== 'enviado') {
    const repete = e.situacao === 'nao_elegivel' && /opt-?in|consent/i.test(e.motivo || '');
    return `<span class="fc-res fc-res-off">${SITUACAO_ENVIO[e.situacao] || escapar(e.situacao)}</span>`
      + (e.motivo && !repete ? `<div class="mk-dim">${escapar(e.motivo)}</div>` : '');
  }
  const n = Number(e.cliques) || 0;
  const passos = [
    [e.entregue, 'entregue'], [e.lido, 'lido'], [n > 0, n === 1 ? '1 clique' : `${n} cliques`],
    [e.respondeu, 'respondeu'], [e.converteu, 'converteu'],
  ].filter(([ok]) => ok);
  return passos.length
    ? `<div class="fc-res-lista">${passos.map(([, t]) => `<span class="fc-res">${t}</span>`).join('')}</div>`
    : '<span class="mk-dim">enviado</span>';
}

// Contato com opt-in: o formulário fica recolhido para o opt-out não
// ficar em destaque (evita registro por engano).
function blocoRecolhido() {
  return `<p class="fc-sub">O cliente já autorizou receber campanhas. Se ele pedir para parar, registre o opt-out.</p>
    <button type="button" class="mk-btn mk-btn-ghost" data-expandir>Registrar opt-out…</button>`;
}

function renderFicha(aviso) {
  const c = fichaAtual;
  const nome = c.display_name || formatarTelefone(c.phone);
  const recolher = c.consentimento_atual === 'opt_in';
  const conversa = c.conversas[0];

  fichaConteudo.innerHTML = `
    <header class="fc-head">
      <div class="fc-avatar" aria-hidden="true">${escapar(iniciais(c.display_name))}</div>
      <div class="fc-head-info">
        <h2 id="fc-nome">${escapar(nome)}</h2>
        <div class="mk-dim">${pareceLid(String(c.phone || '')) ? 'número oculto pelo WhatsApp' : formatarTelefone(c.phone)}
          · ${c.platform === 'instagram' ? 'Instagram' : 'WhatsApp'} · cliente desde ${quando(c.created_at, { hora: false })}</div>
      </div>
      <div class="fc-head-acoes">
        ${conversa ? `<a class="mk-btn mk-btn-ghost mk-btn-sm" href="/?conversa=${conversa.id}">Abrir conversa</a>` : ''}
        <button type="button" class="fc-fechar" aria-label="Fechar ficha" data-fechar>&times;</button>
      </div>
    </header>
    ${blocoStatus(c)}
    ${aviso ? `<div class="fc-aviso" role="status">${escapar(aviso)}</div>` : ''}
    <div class="fc-body">
      <div class="fc-col">
        <section class="fc-bloco">
          <h3>${recolher ? 'Consentimento' : 'Registrar consentimento'}</h3>
          <div id="fc-consent">${recolher ? blocoRecolhido() : blocoConsentimento(c, 'opt_in')}</div>
        </section>
        <section class="fc-bloco">
          <h3>Histórico de consentimento</h3>
          <p class="fc-sub">Cada manifestação fica gravada com data e origem e não pode ser editada nem apagada (LGPD).</p>
          ${blocoHistorico(c)}
        </section>
      </div>
      <div class="fc-col">
        <section class="fc-bloco">
          <h3>Interesses <span class="fc-contador" id="fc-int-contador">${c.interesses.length}</span></h3>
          <div id="fc-interesses">${blocoInteresses(c)}</div>
        </section>
        <section class="fc-bloco">
          <h3>Dados do contato</h3>
          ${blocoDados(c)}
        </section>
        <section class="fc-bloco">
          <h3>Atividade</h3>
          ${blocoAtividade(c)}
        </section>
      </div>
    </div>`;

  fichaConteudo.querySelector('[data-fechar]').addEventListener('click', () => ficha.close());
  ligarFormConsentimento();
  ligarFormDados();
  ligarInteresses();
}

function ligarFormConsentimento() {
  const expandir = el('#fc-consent [data-expandir]');
  if (expandir) {
    expandir.addEventListener('click', () => {
      el('#fc-consent').innerHTML = blocoConsentimento(fichaAtual, 'opt_out');
      ligarFormConsentimento();
      el('#fc-form-consent select[name="origem"]').focus();
    });
    return;
  }
  const form = el('#fc-form-consent');
  const msg = form.querySelector('.fc-msg');

  form.querySelectorAll('input[name="tipo"]').forEach((r) => r.addEventListener('change', () => {
    el('#fc-consent').innerHTML = blocoConsentimento(fichaAtual, r.value);
    ligarFormConsentimento();
  }));
  form.origem.addEventListener('change', () => {
    const outro = form.querySelector('[data-outro]');
    outro.classList.toggle('hidden', form.origem.value !== 'outro');
    if (form.origem.value === 'outro') form.origem_outro.focus();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tipo = form.tipo.value;
    const origem = form.origem.value === 'outro' ? form.origem_outro.value.trim() : form.origem.value;
    msg.className = 'fc-msg fc-msg-erro';
    if (!origem) { msg.textContent = 'Descreva como o cliente se manifestou.'; form.origem_outro.focus(); return; }
    if (tipo === 'opt_in' && !form.confirmo.checked) {
      msg.textContent = 'Marque a confirmação de que o cliente autorizou.';
      return;
    }
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    try {
      await api.post(`/api/contatos/${fichaAtual.id}/consentimentos`, {
        tipo,
        origem,
        finalidade: form.finalidade.value.trim() || undefined,
        observacao: form.observacao.value.trim() || undefined,
      });
      await abrirFicha(fichaAtual.id, tipo === 'opt_in'
        ? 'Opt-in registrado. O contato já pode entrar nas campanhas.'
        : 'Opt-out registrado. O contato não recebe mais campanhas.');
      carregarContatos();
    } catch (err) {
      msg.textContent = err.message;
      botao.disabled = false;
    }
  });
}

function ligarFormDados() {
  const form = el('#fc-form-dados');
  const msg = form.querySelector('.fc-msg');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    try {
      await api.patch(`/api/contatos/${fichaAtual.id}`, {
        display_name: form.display_name.value.trim(),
        perfil: form.perfil.value.trim(),
        nivel_engajamento: form.nivel_engajamento.value,
      });
      await abrirFicha(fichaAtual.id, 'Dados do contato salvos.');
      carregarContatos();
    } catch (err) {
      msg.className = 'fc-msg fc-msg-erro';
      msg.textContent = err.message;
      botao.disabled = false;
    }
  });
}


// ------------------------------------------------- interesses na ficha ----
// Clique marca/desmarca e salva sozinho (espera 0,4 s para juntar cliques rápidos).
function blocoInteresses(c) {
  const marcados = new Set(c.interesses.map((i) => i.id));
  const chips = c.catalogo_interesses.map((i) => {
    const on = marcados.has(i.id);
    return `<button type="button" class="fc-int ${on ? 'is-on' : ''}" data-int="${i.id}" aria-pressed="${on}">
      <span class="fc-int-ico" aria-hidden="true">${on ? '✓' : '+'}</span>${escapar(i.nome)}</button>`;
  }).join('');
  return `
    <p class="fc-sub">Clique para marcar ou desmarcar: salva na hora e serve para segmentar campanhas.</p>
    <div class="fc-int-lista" role="group" aria-label="Interesses do cliente">
      ${chips || '<span class="mk-dim">Nenhum interesse criado ainda. Crie o primeiro abaixo.</span>'}</div>
    <form class="fc-int-novo" id="fc-int-novo">
      <input name="nome" maxlength="40" placeholder="Novo interesse (ex.: drones)" aria-label="Novo interesse" autocomplete="off">
      <button class="mk-btn mk-btn-ghost mk-btn-sm" type="submit">Criar e marcar</button>
    </form>
    <div class="fc-int-rodape">
      <p class="fc-msg" role="status" aria-live="polite"></p>
      <button type="button" class="fc-link" data-gerir>Gerenciar lista de interesses</button>
    </div>`;
}

let timerInteresses = null;
function ligarInteresses() {
  const caixa = el('#fc-interesses');
  const idsMarcados = () => els('#fc-interesses .fc-int.is-on').map((b) => Number(b.dataset.int));

  async function salvar() {
    const msg = el('#fc-interesses .fc-msg'); // busca de novo: o bloco pode ter sido redesenhado
    msg.className = 'fc-msg';
    msg.textContent = 'Salvando…';
    try {
      const r = await api.put(`/api/contatos/${fichaAtual.id}/interesses`, { ids: idsMarcados() });
      const antes = new Set(fichaAtual.interesses.map((i) => i.id));
      const depois = new Set(r.interesses.map((i) => i.id));
      fichaAtual.catalogo_interesses.forEach((i) => {
        i.total += (depois.has(i.id) ? 1 : 0) - (antes.has(i.id) ? 1 : 0);
      });
      fichaAtual.interesses = r.interesses;
      fichaAtual.interesse_declarado = r.interesse_declarado;
      el('#fc-int-contador').textContent = r.interesses.length;
      msg.textContent = 'Salvo ✓';
      setTimeout(() => { if (msg.textContent === 'Salvo ✓') msg.textContent = ''; }, 2000);
      carregarContatos();
    } catch (err) {
      caixa.innerHTML = blocoInteresses(fichaAtual); // volta ao que está gravado
      ligarInteresses();
      const m = el('#fc-interesses .fc-msg');
      m.className = 'fc-msg fc-msg-erro';
      m.textContent = err.message;
    }
  }
  const agendar = () => { clearTimeout(timerInteresses); timerInteresses = setTimeout(salvar, 400); };

  caixa.querySelectorAll('[data-int]').forEach((b) => b.addEventListener('click', () => {
    const on = !b.classList.contains('is-on');
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
    b.querySelector('.fc-int-ico').textContent = on ? '✓' : '+';
    agendar();
  }));

  el('#fc-int-novo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const campo = ev.target.nome;
    const nome = campo.value.trim();
    if (!nome) { campo.focus(); return; }
    try {
      const novo = await api.post('/api/contatos/interesses', { nome });
      if (!fichaAtual.catalogo_interesses.some((i) => i.id === novo.id)) {
        fichaAtual.catalogo_interesses.push({ id: novo.id, nome: novo.nome, total: 0 });
        fichaAtual.catalogo_interesses.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
      }
      const marcados = new Set([...idsMarcados(), novo.id]);
      caixa.innerHTML = blocoInteresses({ ...fichaAtual, interesses: fichaAtual.catalogo_interesses.filter((i) => marcados.has(i.id)) });
      ligarInteresses();
      clearTimeout(timerInteresses);
      await salvarAgora();
      el('#fc-int-novo').nome.focus();
    } catch (err) {
      const m = el('#fc-interesses .fc-msg');
      m.className = 'fc-msg fc-msg-erro';
      m.textContent = err.message;
    }
  });
  async function salvarAgora() { await salvar(); }

  caixa.querySelector('[data-gerir]').addEventListener('click', () => abrirGerenciador());
}

// --------------------------------------------- gerenciador de interesses ----
const gerenciador = el('#gerir-interesses');
gerenciador.addEventListener('click', (ev) => { if (ev.target === gerenciador) gerenciador.close(); });
gerenciador.addEventListener('close', async () => {
  // o que mudou aqui aparece na ficha aberta e na lista
  if (ficha.open && fichaAtual) await abrirFicha(fichaAtual.id);
  carregarContatos();
});

async function abrirGerenciador(aviso) {
  if (!gerenciador.open) gerenciador.showModal();
  const lista = await carregarInteresses();
  el('#gi-conteudo').innerHTML = `
    <header class="fc-head">
      <div class="fc-head-info">
        <h2 id="gi-titulo">Interesses</h2>
        <div class="mk-dim">Crie a lista uma vez e marque em cada cliente na ficha dele.</div>
      </div>
      <button type="button" class="fc-fechar" aria-label="Fechar" data-fechar>&times;</button>
    </header>
    <div class="gi-corpo">
      <form id="gi-novo" class="fc-int-novo">
        <input name="nome" maxlength="40" placeholder="Novo interesse (ex.: câmeras)" aria-label="Novo interesse" autocomplete="off">
        <button class="mk-btn mk-btn-sm" type="submit">Adicionar</button>
      </form>
      <p class="fc-msg ${aviso && aviso.erro ? 'fc-msg-erro' : ''}" role="status" aria-live="polite">${aviso ? escapar(aviso.texto) : ''}</p>
      ${lista.length ? `<ul class="gi-lista">${lista.map((i) => `
        <li data-id="${i.id}">
          <input class="gi-nome" value="${escapar(i.nome)}" maxlength="40" aria-label="Nome do interesse ${escapar(i.nome)}">
          <span class="gi-total">${i.total} ${i.total === 1 ? 'cliente' : 'clientes'}</span>
          <button type="button" class="mk-btn mk-btn-ghost mk-btn-sm" data-salvar hidden>Salvar</button>
          <button type="button" class="fc-link fc-link-perigo" data-excluir>Excluir</button>
        </li>`).join('')}</ul>`
        : '<p class="mk-dim">Nenhum interesse ainda. Sugestões: câmeras, lentes, iPhone, notebooks, drones, acessórios.</p>'}
      <p class="fc-sub gi-dica">Para mandar campanha só para quem tem um interesse: em <strong>Segmentos</strong>, crie a regra
        <strong>Interesses · possui · (o interesse)</strong>.</p>
    </div>`;

  el('#gi-conteudo [data-fechar]').addEventListener('click', () => gerenciador.close());
  el('#gi-novo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = ev.target.nome.value.trim();
    if (!nome) return;
    try {
      const r = await api.post('/api/contatos/interesses', { nome });
      await abrirGerenciador({ texto: r.criado ? `"${r.nome}" adicionado.` : `"${r.nome}" já existia.` });
      el('#gi-novo').nome.focus();
    } catch (err) {
      await abrirGerenciador({ texto: err.message, erro: true });
    }
  });

  els('.gi-lista li').forEach((li) => {
    const id = li.dataset.id;
    const campo = li.querySelector('.gi-nome');
    const salvarBtn = li.querySelector('[data-salvar]');
    const excluirBtn = li.querySelector('[data-excluir]');
    const original = campo.value;
    const renomear = async () => {
      if (campo.value.trim() === original) return;
      try {
        const r = await api.patch(`/api/contatos/interesses/${id}`, { nome: campo.value });
        await abrirGerenciador({ texto: `Renomeado para "${r.nome}" (atualizado nos clientes).` });
      } catch (err) {
        await abrirGerenciador({ texto: err.message, erro: true });
      }
    };
    campo.addEventListener('input', () => { salvarBtn.hidden = campo.value.trim() === original; });
    campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); renomear(); } });
    salvarBtn.addEventListener('click', renomear);

    // Excluir em dois cliques: o primeiro pede confirmação no próprio botão.
    let armado = null;
    excluirBtn.addEventListener('click', async () => {
      const total = Number(li.querySelector('.gi-total').textContent.split(' ')[0]) || 0;
      if (!armado) {
        excluirBtn.textContent = total ? `Remover de ${total} ${total === 1 ? 'cliente' : 'clientes'}?` : 'Confirmar exclusão?';
        excluirBtn.classList.add('is-armado');
        armado = setTimeout(() => {
          armado = null;
          excluirBtn.textContent = 'Excluir';
          excluirBtn.classList.remove('is-armado');
        }, 4000);
        return;
      }
      clearTimeout(armado);
      try {
        await api.del(`/api/contatos/interesses/${id}`);
        await abrirGerenciador({ texto: `"${original}" excluído.` });
      } catch (err) {
        await abrirGerenciador({ texto: err.message, erro: true });
      }
    });
  });
}

// ===================================================== janelas (comum) ====
// Mesmo padrão da ficha do contato: <dialog> com fundo desfocado, fecha no ×,
// no Esc e clicando fora. Confirmações no próprio botão, sem caixas do navegador.
function janela(id) {
  const d = el(`#${id}`);
  if (!d.dataset.ligada) {
    d.dataset.ligada = '1';
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }
  if (!d.open) d.showModal();
  return d;
}

function ligarFechar(d) {
  d.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => d.close()));
}

// Primeiro clique arma ("Excluir?"), segundo executa; desarma sozinho em 4 s.
function confirmarNoBotao(btn, textoConfirmar, acao) {
  const original = btn.innerHTML;
  let armado = null;
  btn.addEventListener('click', async () => {
    if (!armado) {
      btn.textContent = textoConfirmar;
      btn.classList.add('is-armado');
      armado = setTimeout(() => { armado = null; btn.innerHTML = original; btn.classList.remove('is-armado'); }, 4000);
      return;
    }
    clearTimeout(armado);
    armado = null;
    btn.disabled = true;
    try { await acao(); } finally {
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = original; btn.classList.remove('is-armado'); }
    }
  });
}

const CARREGANDO = '<div class="fc-carregando">Carregando…</div>';

function cabecalho({ icone, titulo, sub = '', acoes = '', idTitulo }) {
  return `
    <header class="fc-head">
      <div class="fc-avatar mk-ico" aria-hidden="true">${icone}</div>
      <div class="fc-head-info">
        <h2 id="${idTitulo}">${escapar(titulo)}</h2>
        ${sub ? `<div class="mk-dim">${sub}</div>` : ''}
      </div>
      <div class="fc-head-acoes">${acoes}
        <button type="button" class="fc-fechar" aria-label="Fechar" data-fechar>&times;</button>
      </div>
    </header>`;
}

function chipsFiltro(container, opcoes, atual, aoEscolher) {
  container.innerHTML = opcoes
    .filter((o) => o.sempre || o.total > 0 || o.valor === atual)
    .map((o) => `<button type="button" class="fc-chip ${o.valor === atual ? 'is-active' : ''}" data-v="${o.valor}"
      aria-pressed="${o.valor === atual}">${o.rotulo} <span>${o.total}</span></button>`).join('');
  container.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => aoEscolher(b.dataset.v)));
}

function cardClicavel(container, seletor, abrir) {
  container.querySelectorAll(seletor).forEach((card) => {
    card.addEventListener('click', () => abrir(card));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(card); }
    });
  });
}

const ICONE = {
  auto: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  manual: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  segmento: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
  modelo: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>',
};

// Texto de WhatsApp: *negrito* e _itálico_ na prévia.
function formatarWhats(texto) {
  return escapar(texto)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<span class="wa-link">$1</span>')
    .replace(/\n/g, '<br>');
}

function bolhaWhats(texto, rodape = '') {
  return `<div class="wa-tela">
      <div class="wa-bolha">${texto ? formatarWhats(texto) : '<span class="mk-dim">Mensagem vazia</span>'}
        <span class="wa-hora">09:41 ✓✓</span></div>
      ${rodape ? `<div class="wa-rodape">${rodape}</div>` : ''}
    </div>`;
}

const PARAM_ROTULO = {
  primeiro_nome: 'Primeiro nome', display_name: 'Nome completo', perfil: 'Perfil',
  interesse_declarado: 'Interesses', nivel_engajamento: 'Engajamento', phone: 'Telefone', _link: 'Link rastreado',
};
const LINK_EXEMPLO = 'https://exemplo.com/r/a1b2c3';

function parametrosDe(modelo) {
  try {
    const l = JSON.parse(modelo.parametros || modelo.modelo_parametros || '[]');
    return Array.isArray(l) ? l : [];
  } catch { return []; }
}

// Mesma regra do servidor (templateRenderer.js), para a prévia ao vivo.
function renderizarModelo(corpo, parametros, contato) {
  const c = contato || {};
  const valor = (a) => {
    if (a === '_link') return LINK_EXEMPLO;
    if (a === 'display_name') return c.display_name || 'cliente';
    if (a === 'primeiro_nome') return String(c.display_name || '').trim().split(/\s+/)[0] || 'cliente';
    return c[a] != null ? String(c[a]) : '';
  };
  let texto = corpo || '';
  parametros.forEach((a, i) => { texto = texto.split(`{{${i + 1}}}`).join(valor(a)); });
  return texto;
}

// Corpo com as variáveis trocadas pelo nome do campo: "Oi [Primeiro nome]!"
function corpoComRotulos(corpo, parametros) {
  let texto = corpo || '';
  parametros.forEach((a, i) => { texto = texto.split(`{{${i + 1}}}`).join(`[${PARAM_ROTULO[a] || a}]`); });
  return texto;
}

// ============================================================ campanhas ====
const SITUACAO_CAMPANHA = {
  rascunho: { texto: 'Rascunho', classe: '' },
  agendada: { texto: 'Agendada', classe: 'mk-badge-warn' },
  em_execucao: { texto: 'Enviando', classe: 'mk-badge-warn' },
  concluida: { texto: 'Concluída', classe: 'mk-badge-ok' },
  cancelada: { texto: 'Cancelada', classe: 'mk-badge-off' },
};
const CENARIO = { automatizado: 'Automatizada', manual: 'Manual' };
const APROVACAO = {
  aprovado: { texto: 'Aprovado', classe: 'mk-badge-ok' },
  pendente: { texto: 'Pendente', classe: 'mk-badge-warn' },
  rascunho: { texto: 'Rascunho', classe: '' },
  rejeitado: { texto: 'Rejeitado', classe: 'mk-badge-off' },
};
let cacheCampanhas = [];
let filtroCampanha = 'todas';

async function carregarCampanhas() {
  const [campanhas, segmentos, modelos] = await Promise.all([
    api.get('/api/campanhas'), api.get('/api/segmentos'), api.get('/api/modelos'),
  ]);
  cacheCampanhas = campanhas;
  cacheSegmentos = segmentos;
  cacheModelos = modelos;
  renderCampanhas();
}

function renderCampanhas() {
  const conta = (s) => cacheCampanhas.filter((c) => c.situacao === s).length;
  chipsFiltro(el('#filtro-campanhas'), [
    { valor: 'todas', rotulo: 'Todas', total: cacheCampanhas.length, sempre: true },
    { valor: 'rascunho', rotulo: 'Rascunhos', total: conta('rascunho') },
    { valor: 'agendada', rotulo: 'Agendadas', total: conta('agendada') },
    { valor: 'em_execucao', rotulo: 'Enviando', total: conta('em_execucao') },
    { valor: 'concluida', rotulo: 'Concluídas', total: conta('concluida') },
    { valor: 'cancelada', rotulo: 'Canceladas', total: conta('cancelada') },
  ], filtroCampanha, (v) => { filtroCampanha = v; renderCampanhas(); });

  const lista = cacheCampanhas.filter((c) => filtroCampanha === 'todas' || c.situacao === filtroCampanha);
  const caixa = el('#lista-campanhas');
  if (!cacheCampanhas.length) {
    caixa.innerHTML = `<div class="mk-vazio"><p>Nenhuma campanha ainda.</p>
      <button type="button" class="mk-btn" data-nova>Criar a primeira campanha</button></div>`;
    caixa.querySelector('[data-nova]').addEventListener('click', () => abrirNovaCampanha());
    return;
  }
  caixa.innerHTML = lista.length ? lista.map((c) => {
    const s = SITUACAO_CAMPANHA[c.situacao] || { texto: c.situacao, classe: '' };
    const quandoTxt = c.situacao === 'agendada' && c.agendamento
      ? `agendada para ${quando(c.agendamento)}` : `criada em ${quando(c.created_at, { hora: false })}`;
    const enviados = Number(c.total_enviados) || 0;
    return `
      <div class="mk-card fc-item" data-campanha="${c.id}" tabindex="0" role="button" aria-label="Abrir campanha ${escapar(c.nome)}">
        <div class="fc-avatar fc-avatar-sm mk-ico mk-ico-${c.cenario}" aria-hidden="true">${c.cenario === 'automatizado' ? ICONE.auto : ICONE.manual}</div>
        <div class="fc-item-info">
          <div class="mk-card-title">${escapar(c.nome)}
            <span class="mk-badge ${s.classe}">${s.texto}</span>
            <span class="mk-badge">${CENARIO[c.cenario] || c.cenario}</span></div>
          <div class="mk-card-meta">${escapar(c.segmento_nome)} · modelo ${escapar(c.modelo_nome)} · ${quandoTxt}</div>
          ${enviados ? `<div class="mk-kpis-linha">
            <span><strong>${enviados}</strong> enviados</span>
            <span><strong>${pct(c.taxa_resposta)}</strong> resposta</span>
            <span><strong>${pct(c.taxa_clique)}</strong> clique</span>
            <span><strong>${Number(c.total_conversoes) || 0}</strong> ${Number(c.total_conversoes) === 1 ? 'conversão' : 'conversões'}</span>
          </div>` : ''}
        </div>
        <span class="fc-item-abrir">Abrir →</span>
      </div>`;
  }).join('') : '<p class="mk-dim">Nenhuma campanha neste filtro.</p>';
  cardClicavel(caixa, '[data-campanha]', (card) => abrirCampanha(card.dataset.campanha));
}

el('#nova-campanha').addEventListener('click', () => abrirNovaCampanha());

// ---------------------------------------------------- ficha da campanha ----
let campanhaAtual = null;
let timerCampanha = null;
let filtroEnvios = 'todos';

async function abrirCampanha(id, aviso) {
  const d = janela('dlg-campanha');
  const caixa = el('#dlg-campanha-conteudo');
  if (!campanhaAtual || campanhaAtual.id !== Number(id) || caixa.dataset.modo !== 'ver') {
    caixa.innerHTML = CARREGANDO;
    filtroEnvios = 'todos';
  }
  caixa.dataset.modo = 'ver';
  clearTimeout(timerCampanha);
  try {
    const [c, envios, dest] = await Promise.all([
      api.get(`/api/campanhas/${id}`),
      api.get(`/api/campanhas/${id}/envios`),
      api.get(`/api/campanhas/${id}/destinatarios`).catch(() => null),
    ]);
    const amostra = dest && (dest.contatos.find((x) => x.elegivel) || dest.contatos[0]);
    let previa = null;
    try {
      previa = (await api.post(`/api/modelos/${c.modelo_id}/previa`, amostra ? { contact_id: amostra.id } : {})).texto;
    } catch { previa = corpoComRotulos(c.corpo, parametrosDe(c)); }
    campanhaAtual = { ...c, envios, dest, previa, amostra };
    renderCampanha(aviso);
    // Enviando: a janela se atualiza sozinha até a campanha terminar.
    if (c.situacao === 'em_execucao') {
      timerCampanha = setTimeout(() => { if (d.open && campanhaAtual && campanhaAtual.id === c.id) abrirCampanha(c.id); }, 5000);
    }
  } catch (err) {
    caixa.innerHTML = `<div class="fc-carregando">Não foi possível abrir a campanha: ${escapar(err.message)}
      <button class="mk-btn mk-btn-ghost mk-btn-sm" data-fechar>Fechar</button></div>`;
    ligarFechar(d);
  }
}
el('#dlg-campanha').addEventListener('close', () => clearTimeout(timerCampanha));

function statusCampanha(c) {
  const enviados = Number((c.metricas || {}).total_enviados) || 0;
  const mapa = {
    rascunho: ['neutro', 'Rascunho', c.cenario === 'automatizado'
      ? 'Ainda não foi disparada. Confira a mensagem e quem recebe, e clique em Disparar agora.'
      : 'Campanha manual (linha de base): os envios são registrados pelo atendimento.'],
    agendada: ['neutro', 'Agendada', `Disparo em ${quando(c.agendamento)}, feito automaticamente pelo sistema.`],
    em_execucao: ['neutro', 'Enviando…', 'As mensagens saem com intervalo entre uma e outra. Esta janela se atualiza sozinha.'],
    concluida: ['ok', 'Concluída', `${enviados} ${enviados === 1 ? 'mensagem enviada' : 'mensagens enviadas'}.`],
    cancelada: ['off', 'Cancelada', 'Esta campanha não será disparada.'],
  };
  const [tom, titulo, texto] = mapa[c.situacao] || ['neutro', c.situacao, ''];
  let html = `<div class="fc-status fc-status-${tom}"><strong>${titulo}</strong><span>${texto}</span></div>`;
  if (c.cenario === 'automatizado' && c.situacao_aprovacao !== 'aprovado' && ['rascunho', 'agendada'].includes(c.situacao)) {
    html += `<div class="fc-aviso fc-aviso-alerta">O modelo <strong>${escapar(c.modelo_nome)}</strong> está como
      ${(APROVACAO[c.situacao_aprovacao] || {}).texto || c.situacao_aprovacao}: só modelos aprovados pela Meta podem ser disparados.
      <button type="button" class="fc-link" data-abrir-modelo="${c.modelo_id}">Abrir modelo</button></div>`;
  }
  return html;
}

// Funil: uma série só (cor única); cada barra é proporcional aos enviados.
function blocoFunil(c) {
  const m = c.metricas || {};
  const base = Number(m.total_enviados) || 0;
  if (!base) {
    const d = c.dest;
    return `<p class="mk-dim">Ainda sem envios.${d ? ` O segmento tem <strong>${d.total}</strong> ${d.total === 1 ? 'contato' : 'contatos'},
      dos quais <strong>${d.elegiveis}</strong> com opt-in recebem.` : ''}</p>`;
  }
  const etapas = [
    ['Enviados', base], ['Entregues', m.total_entregues], ['Lidos', m.total_lidos],
    ['Responderam', m.total_respostas], ['Clicaram', m.total_cliques], ['Converteram', m.total_conversoes],
  ];
  const linhas = etapas.map(([rotulo, v]) => {
    const n = Number(v) || 0;
    const frac = Math.min(1, n / base);
    return `<div class="cp-funil-linha" title="${rotulo}: ${n} de ${base} (${pct(frac)})">
      <span class="cp-funil-rotulo">${rotulo}</span>
      <span class="cp-funil-trilha">
        <span class="cp-funil-barra" style="width:${n ? `max(2px, ${(frac * 100).toFixed(1)}%)` : '0'}"></span>
        <span class="cp-funil-valor"><strong>${n}</strong>${rotulo === 'Enviados' ? '' : ` <span class="mk-dim">${pct(frac)}</span>`}</span>
      </span>
    </div>`;
  }).join('');
  const bloqueados = c.envios.filter((e) => e.situacao === 'nao_elegivel').length;
  const falhas = c.envios.filter((e) => e.situacao === 'falha').length;
  return `<div class="cp-funil" role="img" aria-label="Funil da campanha">${linhas}</div>
    <div class="cp-funil-extra">
      <span>Tempo médio até a resposta: <strong>${segundos(m.tempo_medio_resposta)}</strong></span>
      ${bloqueados ? `<span>${bloqueados} sem opt-in (não enviados)</span>` : ''}
      ${falhas ? `<span class="cp-falha">${falhas} ${falhas === 1 ? 'falha' : 'falhas'}</span>` : ''}
    </div>`;
}

function blocoConfig(c) {
  const editavel = ['rascunho', 'agendada'].includes(c.situacao);
  const ag = c.agendamento ? new Date(String(c.agendamento).replace(' ', 'T') + (/[zZ]$/.test(c.agendamento) ? '' : 'Z')) : null;
  const local = ag && !Number.isNaN(ag.getTime())
    ? new Date(ag.getTime() - ag.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  const dl = `<dl class="fc-dl">
      <dt>Segmento</dt><dd><button type="button" class="fc-link" data-abrir-segmento="${c.segmento_id}">${escapar(c.segmento_nome)}</button></dd>
      <dt>Modelo</dt><dd><button type="button" class="fc-link" data-abrir-modelo="${c.modelo_id}">${escapar(c.modelo_nome)}</button>
        <span class="mk-badge ${(APROVACAO[c.situacao_aprovacao] || {}).classe || ''}">${(APROVACAO[c.situacao_aprovacao] || {}).texto || c.situacao_aprovacao}</span></dd>
      <dt>Tipo</dt><dd>${CENARIO[c.cenario] || c.cenario}</dd>
      ${!editavel ? `<dt>Agendamento</dt><dd>${quando(c.agendamento)}</dd>
      <dt>Link de destino</dt><dd>${c.url_destino ? escapar(c.url_destino) : '—'}</dd>` : ''}
      <dt>Criada em</dt><dd>${quando(c.created_at)}${c.criado_por_nome ? ` · por ${escapar(c.criado_por_nome)}` : ''}</dd>
    </dl>`;
  if (!editavel) return dl;
  return `
    <form id="cp-form-config" class="fc-form">
      <label>Nome da campanha <input name="nome" value="${escapar(c.nome)}" maxlength="120" required></label>
      <div class="fc-grid2">
        <label>Agendar disparo <input name="agendamento" type="datetime-local" value="${local}"></label>
        <label>Link de destino <input name="url_destino" type="url" value="${escapar(c.url_destino || '')}" placeholder="https://…"></label>
      </div>
      <div class="fc-form-acoes">
        <button type="submit" class="mk-btn mk-btn-ghost">Salvar alterações</button>
        <button type="button" class="fc-link fc-link-perigo" data-cancelar-campanha>Cancelar campanha</button>
        <p class="fc-msg" role="status" aria-live="polite"></p>
      </div>
    </form>
    ${dl}`;
}

const GRUPOS_ENVIO = {
  todos: () => true,
  responderam: (e) => Number(e.respondeu) > 0,
  leram: (e) => Number(e.lido) > 0,
  sem_leitura: (e) => e.situacao === 'enviado' && !Number(e.lido),
  nao_enviados: (e) => e.situacao !== 'enviado',
};
function opcoesEnvios(c) {
  return [
    { valor: 'todos', rotulo: 'Todos', sempre: true },
    { valor: 'responderam', rotulo: 'Responderam' },
    { valor: 'leram', rotulo: 'Leram' },
    { valor: 'sem_leitura', rotulo: 'Não leram' },
    { valor: 'nao_enviados', rotulo: 'Não enviados' },
  ].map((o) => ({ ...o, total: c.envios.filter(GRUPOS_ENVIO[o.valor]).length }));
}

function blocoEnvios(c) {
  const env = c.envios;
  const lista = env.filter(GRUPOS_ENVIO[filtroEnvios] || GRUPOS_ENVIO.todos);
  return `
    <div class="fc-chips cp-chips" id="cp-filtro-envios"></div>
    <ul class="cp-envios">${lista.map((e) => `
      <li data-envio="${e.id}">
        <button type="button" class="cp-envio-nome" data-contato="${e.contact_id}">${escapar(e.display_name || formatarTelefone(e.phone))}</button>
        <span class="cp-envio-res">${resultadoEnvio(e)}</span>
        <span class="cp-envio-acao">${e.situacao === 'enviado' && !Number(e.converteu)
          ? '<button type="button" class="fc-link" data-conversao>Marcar venda</button>' : ''}</span>
      </li>`).join('') || '<li class="mk-dim">Nenhum envio neste filtro.</li>'}</ul>`;
}

function blocoDestinatarios(c) {
  const d = c.dest;
  if (!d) return '<p class="mk-dim">Não foi possível calcular os destinatários.</p>';
  const fora = d.total - d.elegiveis;
  return `
    <div class="sg-numeros">
      <div><strong>${d.elegiveis}</strong><span>recebem (opt-in)</span></div>
      <div><strong>${fora}</strong><span>ficam de fora</span></div>
      <div><strong>${d.total}</strong><span>no segmento</span></div>
    </div>
    <ul class="sg-amostra">${d.contatos.slice(0, 50).map((x) => `
      <li><button type="button" class="cp-envio-nome" data-contato="${x.id}">${escapar(x.display_name || formatarTelefone(x.phone))}</button>
        <span class="mk-badge ${x.elegivel ? 'mk-badge-ok' : 'mk-badge-warn'}">${x.elegivel ? 'recebe' : 'sem opt-in'}</span></li>`).join('')}
    </ul>
    ${d.contatos.length > 50 ? `<p class="mk-dim">… e mais ${d.contatos.length - 50}.</p>` : ''}`;
}

function blocoExecucoes(c) {
  if (!c.execucoes || !c.execucoes.length) return '';
  return `<section class="fc-bloco"><h3>Registro de execuções</h3>
    <ol class="fc-timeline">${c.execucoes.map((x) => `
      <li class="${x.resultado === 'sucesso' || x.resultado === 'ok' ? 'is-in' : x.resultado ? 'is-out' : ''}">
        <div class="fc-tl-top"><span class="mk-badge">${escapar(x.resultado || 'em andamento')}</span><time>${quando(x.inicio)}</time></div>
        <div class="fc-tl-origem">${escapar(x.fluxo)}${x.fim ? ` <span class="mk-dim">· terminou ${quando(x.fim, { curto: true })}</span>` : ''}</div>
        ${x.detalhe ? `<div class="fc-tl-obs">${escapar(String(x.detalhe).slice(0, 300))}</div>` : ''}
      </li>`).join('')}</ol></section>`;
}

function renderCampanha(aviso) {
  const c = campanhaAtual;
  const d = el('#dlg-campanha');
  const caixa = el('#dlg-campanha-conteudo');
  const podeDisparar = c.cenario === 'automatizado' && ['rascunho', 'agendada'].includes(c.situacao);
  const temEnvios = c.envios.length > 0;
  caixa.innerHTML = `
    ${cabecalho({
      icone: c.cenario === 'automatizado' ? ICONE.auto : ICONE.manual,
      titulo: c.nome,
      idTitulo: 'cp-titulo',
      sub: `${CENARIO[c.cenario] || c.cenario} · segmento ${escapar(c.segmento_nome)} · modelo ${escapar(c.modelo_nome)}`,
      acoes: podeDisparar ? '<button type="button" class="mk-btn" data-disparar>Disparar agora</button>' : '',
    })}
    <div id="cp-topo">${statusCampanha(c)}</div>
    ${aviso ? `<div class="fc-aviso" role="status">${escapar(aviso)}</div>` : ''}
    <div class="fc-body">
      <div class="fc-col">
        <section class="fc-bloco"><h3>Resultado</h3>${blocoFunil(c)}</section>
        <section class="fc-bloco"><h3>Mensagem</h3>
          ${bolhaWhats(c.previa, c.amostra ? `Prévia com os dados de ${escapar(c.amostra.display_name || 'um contato')}` : '')}</section>
        <section class="fc-bloco"><h3>${['rascunho', 'agendada'].includes(c.situacao) ? 'Configurações' : 'Detalhes'}</h3>${blocoConfig(c)}</section>
      </div>
      <div class="fc-col">
        <section class="fc-bloco">
          <h3>${temEnvios ? `Envios <span class="fc-contador">${c.envios.length}</span>` : 'Quem vai receber'}</h3>
          <div id="cp-pessoas">${temEnvios ? blocoEnvios(c) : blocoDestinatarios(c)}</div>
        </section>
        ${blocoExecucoes(c)}
      </div>
    </div>`;
  ligarFechar(d);
  ligarCampanha();
}

function ligarCampanha() {
  const c = campanhaAtual;
  const caixa = el('#dlg-campanha-conteudo');

  caixa.querySelectorAll('[data-abrir-modelo]').forEach((b) => b.addEventListener('click', () => abrirModelo(b.dataset.abrirModelo)));
  caixa.querySelectorAll('[data-abrir-segmento]').forEach((b) => b.addEventListener('click', () => abrirSegmento(b.dataset.abrirSegmento)));
  caixa.querySelectorAll('[data-contato]').forEach((b) => b.addEventListener('click', () => abrirFicha(b.dataset.contato)));

  if (el('#cp-filtro-envios')) {
    chipsFiltro(el('#cp-filtro-envios'), opcoesEnvios(c), filtroEnvios, (v) => {
      filtroEnvios = v;
      el('#cp-pessoas').innerHTML = blocoEnvios(c);
      ligarCampanha();
    });
  }

  // Venda/conversão registrada na própria linha (sem caixa do navegador).
  caixa.querySelectorAll('[data-conversao]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('li');
    const acao = li.querySelector('.cp-envio-acao');
    acao.innerHTML = `<form class="cp-conv">
      <input name="valor" inputmode="decimal" placeholder="Valor (opcional)" aria-label="Valor da venda">
      <button type="submit" class="mk-btn mk-btn-sm">Confirmar</button>
      <button type="button" class="fc-link" data-desfazer>cancelar</button></form>`;
    const f = acao.querySelector('form');
    f.valor.focus();
    f.querySelector('[data-desfazer]').addEventListener('click', () => { el('#cp-pessoas').innerHTML = blocoEnvios(c); ligarCampanha(); });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const bruto = f.valor.value.trim().replace(/\./g, '').replace(',', '.');
      if (bruto && Number.isNaN(Number(bruto))) { f.valor.focus(); f.valor.setCustomValidity('Número inválido'); f.valor.reportValidity(); return; }
      try {
        await api.post(`/api/campanhas/${c.id}/conversoes`, { envio_id: Number(li.dataset.envio), valor: bruto ? Number(bruto) : null, origem: 'manual' });
        await abrirCampanha(c.id, 'Venda registrada na campanha.');
        carregarCampanhas();
      } catch (err) { await abrirCampanha(c.id, err.message); }
    });
  }));

  const btnDisparar = caixa.querySelector('[data-disparar]');
  if (btnDisparar) btnDisparar.addEventListener('click', () => mostrarConfirmacaoDisparo());

  const form = el('#cp-form-config');
  if (form) {
    const msg = form.querySelector('.fc-msg');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!form.nome.value.trim()) { form.nome.focus(); return; }
      const corpo = { nome: form.nome.value.trim(), url_destino: form.url_destino.value.trim() || null };
      if (form.agendamento.value) {
        corpo.agendamento = new Date(form.agendamento.value).toISOString();
        if (c.situacao === 'rascunho') corpo.situacao = 'agendada';
      }
      try {
        await api.patch(`/api/campanhas/${c.id}`, corpo);
        await abrirCampanha(c.id, corpo.situacao === 'agendada' ? 'Campanha agendada.' : 'Alterações salvas.');
        carregarCampanhas();
      } catch (err) { msg.className = 'fc-msg fc-msg-erro'; msg.textContent = err.message; }
    });
    confirmarNoBotao(form.querySelector('[data-cancelar-campanha]'), 'Cancelar mesmo? (não volta)', async () => {
      await api.patch(`/api/campanhas/${c.id}`, { situacao: 'cancelada' });
      await abrirCampanha(c.id, 'Campanha cancelada.');
      carregarCampanhas();
    });
  }
}

function mostrarConfirmacaoDisparo() {
  const c = campanhaAtual;
  const d = c.dest || { total: 0, elegiveis: 0 };
  const fora = d.total - d.elegiveis;
  el('#cp-topo').innerHTML = `
    <div class="fc-status fc-status-neutro cp-confirmar">
      <div>
        <strong>Disparar para ${d.elegiveis} ${d.elegiveis === 1 ? 'contato' : 'contatos'}?</strong>
        <span>${fora ? `${fora} do segmento ${fora === 1 ? 'fica' : 'ficam'} de fora por não ter opt-in. ` : ''}A mensagem sai pelo WhatsApp conectado e não dá para desfazer.</span>
      </div>
      <div class="cp-confirmar-acoes">
        <button type="button" class="mk-btn" data-confirmar ${d.elegiveis ? '' : 'disabled'}>Confirmar disparo</button>
        <button type="button" class="mk-btn mk-btn-ghost" data-voltar>Voltar</button>
      </div>
    </div>`;
  el('#cp-topo [data-voltar]').addEventListener('click', () => { el('#cp-topo').innerHTML = statusCampanha(c); ligarCampanha(); });
  el('#cp-topo [data-confirmar]').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Disparando…';
    try {
      const r = await api.post(`/api/campanhas/${c.id}/executar`);
      const aviso = `Concluída: ${r.enviados} enviados, ${r.nao_elegiveis} sem consentimento, ${r.falhas} falhas.`;
      await abrirCampanha(c.id, aviso);
      carregarCampanhas();
    } catch (err) {
      el('#cp-topo').innerHTML = `${statusCampanha(c)}<div class="fc-aviso fc-aviso-erro" role="alert">${escapar(err.message)}</div>`;
      ligarCampanha();
    }
  });
}

// ---------------------------------------------------- nova campanha ----
async function abrirNovaCampanha(preset = {}) {
  const d = janela('dlg-campanha');
  const caixa = el('#dlg-campanha-conteudo');
  caixa.dataset.modo = 'nova';
  campanhaAtual = null;
  clearTimeout(timerCampanha);
  caixa.innerHTML = CARREGANDO;
  const [segmentos, modelos] = await Promise.all([api.get('/api/segmentos'), api.get('/api/modelos')]);
  cacheSegmentos = segmentos;
  cacheModelos = modelos;

  const faltando = !segmentos.length || !modelos.length;
  caixa.innerHTML = `
    ${cabecalho({ icone: ICONE.auto, titulo: 'Nova campanha', idTitulo: 'cp-titulo', sub: 'Escolha quem recebe (segmento) e o que recebe (modelo).' })}
    ${faltando ? `<div class="fc-status fc-status-neutro"><strong>Falta preparar</strong><span>
        Para criar uma campanha você precisa de ${!segmentos.length ? 'pelo menos um segmento' : ''}${!segmentos.length && !modelos.length ? ' e ' : ''}${!modelos.length ? 'pelo menos um modelo' : ''}.</span></div>
      <div class="fc-body fc-body-1"><div class="mk-actions">
        ${!segmentos.length ? '<button type="button" class="mk-btn" data-criar-seg>Criar segmento</button>' : ''}
        ${!modelos.length ? '<button type="button" class="mk-btn" data-criar-mod>Criar modelo</button>' : ''}
      </div></div>` : `
    <form id="cp-form-nova" class="fc-body" novalidate>
      <div class="fc-col">
        <section class="fc-bloco fc-form">
          <label>Nome da campanha <input name="nome" maxlength="120" required placeholder="Ex.: Promo lentes novembro" value="${escapar(preset.nome || '')}"></label>
          <div class="fc-seg" role="radiogroup" aria-label="Tipo de campanha">
            <label><input type="radio" name="cenario" value="automatizado" checked><span>Automatizada · o sistema dispara</span></label>
            <label><input type="radio" name="cenario" value="manual"><span>Manual · envio pelo atendimento</span></label>
          </div>
          <label>Quem recebe (segmento)
            <select name="segmento_id">${segmentos.map((s) => `<option value="${s.id}" ${Number(preset.segmento_id) === s.id ? 'selected' : ''}>${escapar(s.nome)}</option>`).join('')}</select></label>
          <p class="cp-info" id="cp-info-seg" role="status" aria-live="polite"></p>
          <label>Mensagem (modelo)
            <select name="modelo_id">${modelos.map((m) => `<option value="${m.id}" ${Number(preset.modelo_id) === m.id ? 'selected' : ''}>${escapar(m.nome)} · ${(APROVACAO[m.situacao_aprovacao] || {}).texto || m.situacao_aprovacao}</option>`).join('')}</select></label>
          <div class="fc-grid2">
            <label><span>Agendar disparo <span class="fc-opcional">opcional</span></span><input name="agendamento" type="datetime-local"></label>
            <label><span>Link de destino <span class="fc-opcional">opcional</span></span><input name="url_destino" type="url" placeholder="https://…"></label>
          </div>
          <p class="fc-sub">Sem agendamento, você dispara quando quiser pela ficha da campanha. O link vira um link
            rastreado por cliente quando o modelo usa a variável <em>Link rastreado</em>.</p>
          <div class="fc-form-acoes">
            <button type="submit" class="mk-btn">Criar campanha</button>
            <button type="button" class="mk-btn mk-btn-ghost" data-fechar>Cancelar</button>
            <p class="fc-msg" role="status" aria-live="polite"></p>
          </div>
        </section>
      </div>
      <div class="fc-col">
        <section class="fc-bloco"><h3>Prévia da mensagem</h3><div id="cp-previa-nova"></div></section>
      </div>
    </form>`}`;
  ligarFechar(d);
  const btnSeg = caixa.querySelector('[data-criar-seg]');
  if (btnSeg) btnSeg.addEventListener('click', () => { d.close(); abrirSegmento(null); });
  const btnMod = caixa.querySelector('[data-criar-mod]');
  if (btnMod) btnMod.addEventListener('click', () => { d.close(); abrirModelo(null); });
  if (faltando) return;

  const form = el('#cp-form-nova');
  const atualizar = async () => {
    const m = cacheModelos.find((x) => x.id === Number(form.modelo_id.value));
    const auto = form.cenario.value === 'automatizado';
    el('#cp-previa-nova').innerHTML = (m ? bolhaWhats(corpoComRotulos(m.corpo, parametrosDe(m)),
      'Os campos entre colchetes são preenchidos com os dados de cada cliente.') : '')
      + (m && auto && m.situacao_aprovacao !== 'aprovado'
        ? `<div class="fc-aviso fc-aviso-alerta">Este modelo está como ${(APROVACAO[m.situacao_aprovacao] || {}).texto}: a campanha pode ser criada,
          mas só dispara depois que o modelo for aprovado.</div>` : '');
    const info = el('#cp-info-seg');
    info.textContent = 'Calculando quem recebe…';
    try {
      const p = await api.get(`/api/segmentos/${form.segmento_id.value}/previa`);
      info.innerHTML = `<strong>${p.elegiveis}</strong> ${p.elegiveis === 1 ? 'contato recebe' : 'contatos recebem'} (com opt-in) · ${p.total} no segmento`;
    } catch { info.textContent = ''; }
  };
  form.addEventListener('change', atualizar);
  atualizar();
  form.nome.focus();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector('.fc-msg');
    if (!form.nome.value.trim()) { msg.className = 'fc-msg fc-msg-erro'; msg.textContent = 'Dê um nome para a campanha.'; form.nome.focus(); return; }
    try {
      const r = await api.post('/api/campanhas', {
        nome: form.nome.value.trim(),
        segmento_id: Number(form.segmento_id.value),
        modelo_id: Number(form.modelo_id.value),
        cenario: form.cenario.value,
        agendamento: form.agendamento.value ? new Date(form.agendamento.value).toISOString() : null,
        url_destino: form.url_destino.value.trim() || null,
      });
      carregarCampanhas();
      await abrirCampanha(r.id, 'Campanha criada.');
    } catch (err) { msg.className = 'fc-msg fc-msg-erro'; msg.textContent = err.message; }
  });
}

// ============================================================ segmentos ====
// Campos e operadores "crus" — usados só pela condição avançada.
const ATRIBUTO_INFO = {
  interesse_declarado: { rotulo: 'Interesses', tipo: 'interesse' },
  nivel_engajamento: { rotulo: 'Nível de engajamento', tipo: 'engajamento' },
  perfil: { rotulo: 'Perfil', tipo: 'texto', sugestoes: ['varejo', 'atacado'] },
  ultima_interacao: { rotulo: 'Última interação', tipo: 'data' },
  created_at: { rotulo: 'Data de cadastro', tipo: 'data' },
  display_name: { rotulo: 'Nome', tipo: 'texto' },
  phone: { rotulo: 'Telefone', tipo: 'texto' },
  platform: { rotulo: 'Canal', tipo: 'canal' },
};
const OPERADORES_POR_TIPO = {
  interesse: ['possui', 'nao_possui', 'contem', 'preenchido', 'vazio'],
  engajamento: ['igual', 'diferente', 'preenchido', 'vazio'],
  texto: ['igual', 'diferente', 'contem', 'comeca_com', 'preenchido', 'vazio'],
  data: ['nos_ultimos_dias', 'sem_interacao_ha_dias', 'preenchido', 'vazio'],
  canal: ['igual', 'diferente'],
};
const OPERADOR_ROTULO = {
  igual: 'é igual a', diferente: 'é diferente de', contem: 'contém', comeca_com: 'começa com',
  maior_que: 'é maior que', menor_que: 'é menor que', nos_ultimos_dias: 'nos últimos', sem_interacao_ha_dias: 'há mais de',
  possui: 'possui', nao_possui: 'não possui', preenchido: 'está preenchido', vazio: 'está vazio',
  possui_algum: 'possui algum de', nao_possui_nenhum: 'não possui nenhum de', em: 'é um de',
};
const SEM_VALOR = ['preenchido', 'vazio'];
const ENGAJ_ROTULO = { alto: 'alto', medio: 'médio', baixo: 'baixo' };
const infoAtributo = (a) => ATRIBUTO_INFO[a] || { rotulo: a, tipo: 'texto' };
const listaItens = (v) => String(v ?? '').split(',').map((t) => t.trim()).filter(Boolean);

function resumoRegra(r) {
  const info = infoAtributo(r.atributo);
  const op = OPERADOR_ROTULO[r.operador] || r.operador;
  if (SEM_VALOR.includes(r.operador)) return `${info.rotulo} ${op}`;
  let v = r.valor_referencia ?? '';
  if (info.tipo === 'engajamento') v = ENGAJ_ROTULO[v] || v;
  if (info.tipo === 'data') v = `${v} dias`;
  return `${info.rotulo} ${op} ${v}`;
}

// ----------------------------------------------- condições em português ----
// Cada cartão do editor é uma "condição" que vira uma ou mais regras no banco.
// Todas as condições valem juntas (E). Dentro de um cartão, várias opções
// marcadas valem como OU ("câmeras ou lentes"), salvo quando se escolhe "todos".
const SVG = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TIPOS_CONDICAO = {
  interesse: { titulo: 'Tem interesse em', ajuda: 'Quem marcou um ou mais interesses', icone: SVG('<path d="M20 12 12 20l-8-8V4h8z"/><circle cx="8.5" cy="8.5" r="1.5"/>') },
  sem_interesse: { titulo: 'Não tem interesse em', ajuda: 'Tira do grupo quem tem esses interesses', icone: SVG('<path d="M20 12 12 20l-8-8V4h8z"/><path d="m3 3 18 18"/>') },
  engajamento: { titulo: 'Nível de engajamento', ajuda: 'Alto, médio ou baixo', icone: SVG('<path d="M4 20V14M10 20V9M16 20V4"/>') },
  ativo: { titulo: 'Falou com a loja nos últimos', ajuda: 'Clientes ativos, que conversaram há pouco', icone: SVG('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>') },
  sumido: { titulo: 'Não fala com a loja há mais de', ajuda: 'Para reconquistar quem sumiu', icone: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
  perfil: { titulo: 'Perfil do cliente', ajuda: 'Varejo ou atacado', icone: SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>') },
  novo: { titulo: 'Cadastrado nos últimos', ajuda: 'Clientes novos', icone: SVG('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>') },
  avancado: { titulo: 'Outra condição', ajuda: 'Nome, telefone, canal ou regra livre', icone: SVG('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>') },
};
const PADRAO_DIAS = { ativo: 30, sumido: 60, novo: 30 };

function regrasParaCondicoes(regras) {
  const out = [];
  const juntar = (tipo, valores, extra = {}) => {
    const atual = out.find((c) => c.tipo === tipo && !c.fixo);
    if (atual && tipo !== 'interesse') { valores.forEach((v) => { if (!atual.valores.includes(v)) atual.valores.push(v); }); return; }
    out.push({ tipo, valores: [...valores], ...extra });
  };
  const possuiSimples = regras.filter((r) => r.atributo === 'interesse_declarado' && r.operador === 'possui');
  if (possuiSimples.length) {
    out.push({ tipo: 'interesse', valores: possuiSimples.map((r) => r.valor_referencia), modo: possuiSimples.length > 1 ? 'todos' : 'algum', fixo: true });
  }
  regras.forEach((r) => {
    const a = r.atributo; const o = r.operador; const v = r.valor_referencia;
    if (a === 'interesse_declarado' && o === 'possui') return;
    if (a === 'interesse_declarado' && o === 'possui_algum') out.push({ tipo: 'interesse', valores: listaItens(v), modo: 'algum' });
    else if (a === 'interesse_declarado' && (o === 'nao_possui' || o === 'nao_possui_nenhum')) juntar('sem_interesse', o === 'nao_possui' ? [v] : listaItens(v));
    else if (a === 'nivel_engajamento' && (o === 'igual' || o === 'em')) juntar('engajamento', o === 'igual' ? [v] : listaItens(v));
    else if (a === 'perfil' && (o === 'igual' || o === 'em')) juntar('perfil', o === 'igual' ? [v] : listaItens(v));
    else if (a === 'ultima_interacao' && o === 'nos_ultimos_dias') out.push({ tipo: 'ativo', dias: Number(v) || 30 });
    else if (a === 'ultima_interacao' && o === 'sem_interacao_ha_dias') out.push({ tipo: 'sumido', dias: Number(v) || 60 });
    else if (a === 'created_at' && o === 'nos_ultimos_dias') out.push({ tipo: 'novo', dias: Number(v) || 30 });
    else out.push({ tipo: 'avancado', regra: { atributo: a, operador: o, valor_referencia: v ?? '' } });
  });
  return out;
}

function condicoesParaRegras(condicoes, { somenteCompletas = false } = {}) {
  const regras = [];
  const varios = (atributo, um, muitos, valores) => {
    if (!valores.length) return;
    regras.push(valores.length === 1
      ? { atributo, operador: um, valor_referencia: valores[0] }
      : { atributo, operador: muitos, valor_referencia: valores.join(', ') });
  };
  condicoes.forEach((c) => {
    if (c.tipo === 'interesse') {
      if (c.modo === 'todos' && c.valores.length > 1) {
        c.valores.forEach((v) => regras.push({ atributo: 'interesse_declarado', operador: 'possui', valor_referencia: v }));
      } else varios('interesse_declarado', 'possui', 'possui_algum', c.valores);
    } else if (c.tipo === 'sem_interesse') varios('interesse_declarado', 'nao_possui', 'nao_possui_nenhum', c.valores);
    else if (c.tipo === 'engajamento') varios('nivel_engajamento', 'igual', 'em', c.valores);
    else if (c.tipo === 'perfil') varios('perfil', 'igual', 'em', c.valores);
    else if (c.tipo === 'ativo') regras.push({ atributo: 'ultima_interacao', operador: 'nos_ultimos_dias', valor_referencia: String(c.dias) });
    else if (c.tipo === 'sumido') regras.push({ atributo: 'ultima_interacao', operador: 'sem_interacao_ha_dias', valor_referencia: String(c.dias) });
    else if (c.tipo === 'novo') regras.push({ atributo: 'created_at', operador: 'nos_ultimos_dias', valor_referencia: String(c.dias) });
    else if (c.tipo === 'avancado') {
      const r = c.regra;
      if (!somenteCompletas || SEM_VALOR.includes(r.operador) || String(r.valor_referencia).trim()) regras.push({ ...r });
    }
  });
  return regras;
}

const ouE = (lista, junta = 'ou') => (lista.length <= 1 ? lista.join('')
  : `${lista.slice(0, -1).join(', ')} ${junta} ${lista[lista.length - 1]}`);

// Frase curta para a lista de segmentos e para o rodapé de cada cartão.
function frasecondicao(c, curta = false) {
  const nomes = (c.valores || []).map((v) => (c.tipo === 'engajamento' ? ENGAJ_ROTULO[v] || v : v));
  switch (c.tipo) {
    case 'interesse': return curta ? `Interesse: ${ouE(nomes, c.modo === 'todos' ? 'e' : 'ou')}`
      : `quem tem interesse em ${ouE(nomes.map((n) => `<strong>${escapar(n)}</strong>`), c.modo === 'todos' ? 'e' : 'ou')}`;
    case 'sem_interesse': return curta ? `Sem interesse em ${ouE(nomes)}`
      : `quem não tem interesse em ${ouE(nomes.map((n) => `<strong>${escapar(n)}</strong>`), 'nem')}`;
    case 'engajamento': return curta ? `Engajamento ${ouE(nomes)}` : `quem tem engajamento ${ouE(nomes.map((n) => `<strong>${n}</strong>`))}`;
    case 'perfil': return curta ? `Perfil ${ouE(nomes)}` : `clientes de ${ouE(nomes.map((n) => `<strong>${escapar(n)}</strong>`))}`;
    case 'ativo': return curta ? `Falou nos últimos ${c.dias} dias` : `quem conversou com a loja nos últimos <strong>${c.dias} dias</strong>`;
    case 'sumido': return curta ? `Sem falar há ${c.dias}+ dias` : `quem não conversa com a loja há mais de <strong>${c.dias} dias</strong>`;
    case 'novo': return curta ? `Cadastrado nos últimos ${c.dias} dias` : `quem se cadastrou nos últimos <strong>${c.dias} dias</strong>`;
    default: return curta ? resumoRegra(c.regra) : escapar(resumoRegra(c.regra));
  }
}

async function carregarSegmentos() {
  if (!metadados.atributos.length) metadados = await api.get('/api/segmentos/metadados');
  const segmentos = await api.get('/api/segmentos');
  cacheSegmentos = segmentos;
  const caixa = el('#lista-segmentos');
  if (!segmentos.length) {
    caixa.innerHTML = `<div class="mk-vazio"><p>Nenhum segmento ainda. Um segmento define quem recebe uma campanha
      (por exemplo: quem tem interesse em câmeras e falou com a loja nos últimos 30 dias).</p>
      <button type="button" class="mk-btn" data-novo>Criar o primeiro segmento</button></div>`;
    caixa.querySelector('[data-novo]').addEventListener('click', () => abrirSegmento(null));
    return;
  }
  const previas = await Promise.all(segmentos.map((s) => api.get(`/api/segmentos/${s.id}/previa`).catch(() => null)));
  caixa.innerHTML = segmentos.map((s, i) => {
    const p = previas[i];
    const frac = p && p.total ? p.elegiveis / p.total : 0;
    const conds = regrasParaCondicoes(s.regras);
    return `
      <div class="mk-card fc-item" data-segmento="${s.id}" tabindex="0" role="button" aria-label="Abrir segmento ${escapar(s.nome)}">
        <div class="fc-avatar fc-avatar-sm mk-ico" aria-hidden="true">${ICONE.segmento}</div>
        <div class="fc-item-info">
          <div class="mk-card-title">${escapar(s.nome)}
            ${s.total_campanhas ? `<span class="mk-badge">${s.total_campanhas} ${s.total_campanhas === 1 ? 'campanha' : 'campanhas'}</span>` : ''}</div>
          ${s.descricao ? `<div class="mk-card-meta">${escapar(s.descricao)}</div>` : ''}
          <div class="fc-tags">${conds.length ? conds.map((c, j) => `${j ? '<span class="sg-e-mini">e</span>' : ''}<span class="sg-regra-tag">${escapar(frasecondicao(c, true))}</span>`).join('')
            : '<span class="mk-dim">sem condições: todos os contatos</span>'}</div>
          ${p ? `<div class="sg-barra-linha">
            <span class="sg-barra" title="${p.elegiveis} de ${p.total} com opt-in"><span style="width:${(frac * 100).toFixed(1)}%"></span></span>
            <span><strong>${p.elegiveis}</strong> com opt-in de ${p.total} ${p.total === 1 ? 'contato' : 'contatos'}</span></div>` : ''}
        </div>
        <span class="fc-item-abrir">Abrir →</span>
      </div>`;
  }).join('');
  cardClicavel(caixa, '[data-segmento]', (card) => abrirSegmento(card.dataset.segmento));
}

el('#novo-segmento').addEventListener('click', () => abrirSegmento(null));

let segmentoAtual = null;
let sgCondicoes = [];
let timerPreviaSeg = null;

async function abrirSegmento(id, aviso) {
  const d = janela('dlg-segmento');
  const caixa = el('#dlg-segmento-conteudo');
  caixa.innerHTML = CARREGANDO;
  const [meta, seg] = await Promise.all([
    metadados.atributos.length ? metadados : api.get('/api/segmentos/metadados'),
    id ? api.get(`/api/segmentos/${id}`) : null,
    carregarInteresses().catch(() => cacheInteresses),
  ]);
  metadados = meta;
  segmentoAtual = seg || { id: null, nome: '', descricao: '', regras: [] };
  sgCondicoes = regrasParaCondicoes(segmentoAtual.regras);
  const usos = id ? (cacheSegmentos.find((s) => s.id === Number(id)) || {}).total_campanhas || 0 : 0;

  caixa.innerHTML = `
    ${cabecalho({
      icone: ICONE.segmento, idTitulo: 'sg-titulo',
      titulo: seg ? seg.nome : 'Novo segmento',
      sub: 'Um grupo de clientes para receber campanhas. Só quem tem opt-in recebe.',
      acoes: seg ? '<button type="button" class="mk-btn mk-btn-ghost mk-btn-sm" data-campanha-seg>Criar campanha com ele</button>' : '',
    })}
    ${aviso ? `<div class="fc-aviso" role="status">${escapar(aviso)}</div>` : ''}
    <form id="sg-form" class="fc-body" novalidate>
      <div class="fc-col">
        <section class="fc-bloco fc-form">
          <label>Nome do segmento <input name="nome" value="${escapar(segmentoAtual.nome)}" maxlength="120" required placeholder="Ex.: Fãs de câmeras"></label>
          <label><span>Descrição <span class="fc-opcional">opcional</span></span>
            <input name="descricao" value="${escapar(segmentoAtual.descricao || '')}" maxlength="200" placeholder="Para que serve este grupo"></label>
        </section>
        <section class="fc-bloco">
          <h3>Quem faz parte</h3>
          <p class="fc-sub">Entram os contatos que atendem a <strong>todas</strong> as condições abaixo.</p>
          <div id="sg-condicoes" class="sg-condicoes"></div>
          <div id="sg-adicionar"></div>
        </section>
        <div class="fc-form-acoes sg-acoes">
          <button type="submit" class="mk-btn">${seg ? 'Salvar segmento' : 'Criar segmento'}</button>
          ${seg ? `<button type="button" class="fc-link fc-link-perigo" data-excluir-seg>Excluir segmento</button>` : ''}
          <p class="fc-msg" role="status" aria-live="polite"></p>
        </div>
        ${usos ? `<p class="fc-sub">Usado em ${usos} ${usos === 1 ? 'campanha' : 'campanhas'}: mudar as condições muda quem recebe as próximas.</p>` : ''}
      </div>
      <div class="fc-col">
        <section class="fc-bloco" aria-live="polite"><h3>Quem entra agora</h3><div id="sg-previa">${CARREGANDO}</div></section>
      </div>
    </form>`;
  ligarFechar(d);
  desenharCondicoes();
  desenharAdicionar(!seg && !sgCondicoes.length);

  const btnCamp = caixa.querySelector('[data-campanha-seg]');
  if (btnCamp) btnCamp.addEventListener('click', () => { d.close(); abrirNovaCampanha({ segmento_id: seg.id }); });

  const form = el('#sg-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector('.sg-acoes .fc-msg');
    msg.className = 'fc-msg fc-msg-erro';
    if (!form.nome.value.trim()) { msg.textContent = 'Dê um nome para o segmento.'; form.nome.focus(); return; }
    sincronizarAvancadas();
    const vazia = sgCondicoes.find((c) => ['interesse', 'sem_interesse', 'engajamento', 'perfil'].includes(c.tipo) && !c.valores.length);
    if (vazia) { msg.textContent = `Marque pelo menos uma opção em "${TIPOS_CONDICAO[vazia.tipo].titulo}" (ou remova a condição).`; return; }
    const semDias = sgCondicoes.find((c) => c.dias !== undefined && !(Number(c.dias) >= 1));
    if (semDias) { msg.textContent = `Informe os dias em "${TIPOS_CONDICAO[semDias.tipo].titulo}".`; return; }
    const regras = condicoesParaRegras(sgCondicoes);
    const incompleta = regras.find((r) => !SEM_VALOR.includes(r.operador) && !String(r.valor_referencia).trim());
    if (incompleta) { msg.textContent = 'Complete a condição avançada (falta o valor).'; return; }
    const corpo = { nome: form.nome.value.trim(), descricao: form.descricao.value.trim(), regras };
    try {
      let novoId = segmentoAtual.id;
      if (novoId) await api.put(`/api/segmentos/${novoId}`, corpo);
      else novoId = (await api.post('/api/segmentos', corpo)).id;
      carregarSegmentos();
      await abrirSegmento(novoId, 'Segmento salvo.');
    } catch (err) { msg.textContent = err.message; }
  });
  const btnExcluir = caixa.querySelector('[data-excluir-seg]');
  if (btnExcluir) {
    confirmarNoBotao(btnExcluir, 'Excluir mesmo?', async () => {
      try {
        await api.del(`/api/segmentos/${seg.id}`);
        d.close();
        alerta(`Segmento "${seg.nome}" excluído.`);
        carregarSegmentos();
      } catch (err) {
        const msg = form.querySelector('.sg-acoes .fc-msg');
        msg.className = 'fc-msg fc-msg-erro';
        msg.textContent = /409|usado/i.test(err.message)
          ? 'Não dá para excluir: há campanhas usando este segmento.' : err.message;
      }
    });
  }
  previaSegmento();
}

// Chips de escolha (interesses, níveis, perfis): clique marca/desmarca.
function chipsEscolha(opcoes, marcados, i) {
  return `<div class="sg-chips" role="group">${opcoes.map(([valor, rotulo]) => {
    const on = marcados.some((m) => String(m).toLowerCase() === String(valor).toLowerCase());
    return `<button type="button" class="fc-int ${on ? 'is-on' : ''}" aria-pressed="${on}" data-cond="${i}" data-escolha="${escapar(valor)}">
      <span class="fc-int-ico" aria-hidden="true">${on ? '✓' : '+'}</span>${escapar(rotulo)}</button>`;
  }).join('')}</div>`;
}

function corpoCondicao(c, i) {
  if (c.tipo === 'interesse' || c.tipo === 'sem_interesse') {
    const nomes = cacheInteresses.map((x) => x.nome);
    c.valores.forEach((v) => { if (!nomes.some((n) => n.toLowerCase() === v.toLowerCase())) nomes.push(v); });
    if (!nomes.length) return '<p class="mk-dim">Nenhum interesse criado ainda. Crie em <strong>Contatos → Interesses</strong>.</p>';
    const modo = c.tipo === 'interesse' && c.valores.length > 1 ? `
      <div class="sg-modo" role="radiogroup" aria-label="Como combinar os interesses">
        <span>Precisa ter</span>
        <label><input type="radio" name="modo-${i}" value="algum" data-cond="${i}" data-modo ${c.modo !== 'todos' ? 'checked' : ''}><span>qualquer um deles</span></label>
        <label><input type="radio" name="modo-${i}" value="todos" data-cond="${i}" data-modo ${c.modo === 'todos' ? 'checked' : ''}><span>todos eles</span></label>
      </div>` : '';
    return chipsEscolha(nomes.map((n) => [n, n]), c.valores, i) + modo;
  }
  if (c.tipo === 'engajamento') return chipsEscolha([['alto', 'Alto'], ['medio', 'Médio'], ['baixo', 'Baixo']], c.valores, i);
  if (c.tipo === 'perfil') {
    const ops = [['varejo', 'Varejo'], ['atacado', 'Atacado']];
    c.valores.forEach((v) => { if (!ops.some(([o]) => o === v.toLowerCase())) ops.push([v, v]); });
    return chipsEscolha(ops, c.valores, i);
  }
  if (c.dias !== undefined) {
    return `<div class="sg-dias">
      <input type="number" min="1" step="1" value="${Number(c.dias) || ''}" data-cond="${i}" data-dias aria-label="Dias"> <span>dias</span>
      <span class="sg-atalhos">${[7, 30, 90].map((n) => `<button type="button" class="fc-chip ${Number(c.dias) === n ? 'is-active' : ''}" data-cond="${i}" data-dias-rapido="${n}">${n} dias</button>`).join('')}</span>
    </div>`;
  }
  return '<div class="sg-avancada" data-avancada></div>';
}

function desenharCondicoes() {
  const caixa = el('#sg-condicoes');
  if (!sgCondicoes.length) {
    caixa.innerHTML = `<div class="sg-sem-cond">Sem condições: entram <strong>todos os contatos</strong>.
      Adicione uma condição para escolher quem recebe.</div>`;
  } else {
    caixa.innerHTML = sgCondicoes.map((c, i) => {
      const t = TIPOS_CONDICAO[c.tipo];
      const frase = c.tipo === 'avancado' || (c.valores && !c.valores.length) ? '' : frasecondicao(c);
      return `${i ? '<div class="sg-e" aria-hidden="true"><span>e</span></div>' : ''}
        <div class="sg-cond" data-i="${i}">
          <div class="sg-cond-topo">
            <span class="sg-cond-ico" aria-hidden="true">${t.icone}</span>
            <strong>${t.titulo}</strong>
            <button type="button" class="sg-remover" data-remover="${i}" aria-label="Remover condição ${t.titulo}">&times;</button>
          </div>
          ${corpoCondicao(c, i)}
          <p class="sg-frase">${frase ? `Entra ${frase}.` : (c.tipo === 'avancado' ? '' : '<span class="sg-falta">Marque pelo menos uma opção.</span>')}</p>
        </div>`;
    }).join('');
  }

  // condição avançada: reaproveita a linha campo / condição / valor
  caixa.querySelectorAll('[data-avancada]').forEach((slot) => {
    const i = Number(slot.closest('.sg-cond').dataset.i);
    const linha = linhaRegra(sgCondicoes[i].regra);
    linha.querySelector('.sg-remover').remove();
    slot.appendChild(linha);
    linha.addEventListener('change', () => { sincronizarAvancadas(); agendarPreviaSeg(); });
    linha.addEventListener('input', () => { sincronizarAvancadas(); agendarPreviaSeg(); });
  });

  caixa.querySelectorAll('[data-escolha]').forEach((b) => b.addEventListener('click', () => {
    const c = sgCondicoes[Number(b.dataset.cond)];
    const v = b.dataset.escolha;
    const ja = c.valores.findIndex((x) => x.toLowerCase() === v.toLowerCase());
    if (ja >= 0) c.valores.splice(ja, 1); else c.valores.push(v);
    redesenhar();
  }));
  caixa.querySelectorAll('[data-modo]').forEach((r) => r.addEventListener('change', () => {
    sgCondicoes[Number(r.dataset.cond)].modo = r.value;
    redesenhar();
  }));
  caixa.querySelectorAll('[data-dias]').forEach((inp) => inp.addEventListener('input', () => {
    const c = sgCondicoes[Number(inp.dataset.cond)];
    c.dias = Number(inp.value) || '';
    const card = inp.closest('.sg-cond');
    card.querySelector('.sg-frase').innerHTML = c.dias ? `Entra ${frasecondicao(c)}.` : '';
    card.querySelectorAll('[data-dias-rapido]').forEach((x) => x.classList.toggle('is-active', Number(x.dataset.diasRapido) === c.dias));
    agendarPreviaSeg();
  }));
  caixa.querySelectorAll('[data-dias-rapido]').forEach((b) => b.addEventListener('click', () => {
    sgCondicoes[Number(b.dataset.cond)].dias = Number(b.dataset.diasRapido);
    redesenhar();
  }));
  caixa.querySelectorAll('[data-remover]').forEach((b) => b.addEventListener('click', () => {
    sincronizarAvancadas(); // guarda o que foi digitado antes de tirar o cartão
    sgCondicoes.splice(Number(b.dataset.remover), 1);
    desenharCondicoes();     // sem sincronizar de novo: a tela ainda é a antiga
    desenharAdicionar(false);
    agendarPreviaSeg();
  }));
}

function redesenhar() {
  sincronizarAvancadas();
  desenharCondicoes();
  agendarPreviaSeg();
}

function sincronizarAvancadas() {
  els('#sg-condicoes .sg-cond').forEach((card) => {
    const linha = card.querySelector('.sg-regra');
    const c = sgCondicoes[Number(card.dataset.i)];
    if (!linha || !c || c.tipo !== 'avancado') return;
    c.regra = {
      atributo: linha.querySelector('.r-atributo').value,
      operador: linha.querySelector('.r-operador').value,
      valor_referencia: (linha.querySelector('.r-valor') || {}).value || '',
    };
  });
}

// "+ Adicionar condição": abre a lista de tipos, com uma linha explicando cada um.
function desenharAdicionar(aberto) {
  const caixa = el('#sg-adicionar');
  const usados = new Set(sgCondicoes.map((c) => c.tipo));
  const disponiveis = Object.entries(TIPOS_CONDICAO).filter(([tipo]) => tipo === 'avancado' || !usados.has(tipo));
  if (!aberto) {
    caixa.innerHTML = `<button type="button" class="mk-btn mk-btn-ghost mk-btn-sm sg-btn-add" data-abrir-tipos>+ Adicionar condição</button>`;
    caixa.querySelector('[data-abrir-tipos]').addEventListener('click', () => desenharAdicionar(true));
    return;
  }
  caixa.innerHTML = `
    <div class="sg-tipos">
      <div class="sg-tipos-topo"><strong>Que tipo de condição?</strong>
        ${sgCondicoes.length ? '<button type="button" class="fc-link" data-fechar-tipos>cancelar</button>' : ''}</div>
      <div class="sg-tipos-grade">${disponiveis.map(([tipo, t]) => `
        <button type="button" class="sg-tipo" data-tipo="${tipo}">
          <span class="sg-cond-ico" aria-hidden="true">${t.icone}</span>
          <span><strong>${t.titulo}${PADRAO_DIAS[tipo] ? ' … dias' : ''}</strong><span>${t.ajuda}</span></span>
        </button>`).join('')}</div>
    </div>`;
  const fechar = caixa.querySelector('[data-fechar-tipos]');
  if (fechar) fechar.addEventListener('click', () => desenharAdicionar(false));
  caixa.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => {
    sincronizarAvancadas();
    const tipo = b.dataset.tipo;
    const nova = { tipo };
    if (PADRAO_DIAS[tipo]) nova.dias = PADRAO_DIAS[tipo];
    else if (tipo === 'engajamento') nova.valores = ['alto'];
    else if (tipo === 'perfil') nova.valores = ['varejo'];
    else if (tipo === 'avancado') nova.regra = { atributo: 'display_name', operador: 'contem', valor_referencia: '' };
    else { nova.valores = []; nova.modo = 'algum'; }
    sgCondicoes.push(nova);
    desenharCondicoes();
    desenharAdicionar(false);
    agendarPreviaSeg();
    const ultimo = els('#sg-condicoes .sg-cond').pop();
    if (ultimo) { ultimo.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); (ultimo.querySelector('button.fc-int, input, select') || ultimo).focus(); }
  }));
}

function linhaRegra(regra = {}) {
  const div = document.createElement('div');
  div.className = 'sg-regra';
  const atributos = Array.from(new Set([...Object.keys(ATRIBUTO_INFO).filter((a) => metadados.atributos.includes(a)), ...metadados.atributos]));
  const montar = (r) => {
    const info = infoAtributo(r.atributo);
    let ops = OPERADORES_POR_TIPO[info.tipo] || metadados.operadores;
    if (r.operador && !ops.includes(r.operador)) ops = [...ops, r.operador];
    const operador = ops.includes(r.operador) ? r.operador : ops[0];
    div.innerHTML = `
      <select class="r-atributo" aria-label="Campo">${atributos.map((a) => `<option value="${a}" ${a === r.atributo ? 'selected' : ''}>${escapar(infoAtributo(a).rotulo)}</option>`).join('')}</select>
      <select class="r-operador" aria-label="Condição">${ops.map((o) => `<option value="${o}" ${o === operador ? 'selected' : ''}>${OPERADOR_ROTULO[o] || o}</option>`).join('')}</select>
      <span class="r-valor-caixa">${campoValor(info, operador, r.valor_referencia ?? '')}</span>
      <button type="button" class="sg-remover" aria-label="Remover regra">&times;</button>`;
    div.querySelector('.r-atributo').addEventListener('change', (ev) => { montar({ atributo: ev.target.value }); });
    div.querySelector('.r-operador').addEventListener('change', (ev) => {
      montar({ atributo: r.atributo, operador: ev.target.value, valor_referencia: (div.querySelector('.r-valor') || {}).value || '' });
    });
  };
  montar({ atributo: regra.atributo || 'display_name', operador: regra.operador, valor_referencia: regra.valor_referencia });
  return div;
}

function campoValor(info, operador, valor) {
  if (SEM_VALOR.includes(operador)) return '<input class="r-valor" type="hidden" value="">';
  const v = escapar(valor);
  if (['possui_algum', 'nao_possui_nenhum', 'em'].includes(operador)) {
    return `<input class="r-valor" value="${v}" aria-label="Valores separados por vírgula" placeholder="valor1, valor2">`;
  }
  if (info.tipo === 'interesse' && operador !== 'contem') {
    const nomes = cacheInteresses.map((i) => i.nome);
    if (valor && !nomes.some((n) => n.toLowerCase() === String(valor).toLowerCase())) nomes.unshift(valor);
    if (!nomes.length) return `<input class="r-valor" value="${v}" placeholder="crie interesses em Contatos">`;
    return `<select class="r-valor" aria-label="Interesse">${nomes.map((n) => `<option ${String(n).toLowerCase() === String(valor).toLowerCase() ? 'selected' : ''}>${escapar(n)}</option>`).join('')}</select>`;
  }
  if (info.tipo === 'engajamento') {
    const niveis = ['alto', 'medio', 'baixo'];
    return `<select class="r-valor" aria-label="Nível">${niveis.map((n) => `<option value="${n}" ${n === valor ? 'selected' : ''}>${ENGAJ_ROTULO[n]}</option>`).join('')}
      ${valor && !niveis.includes(valor) ? `<option selected>${v}</option>` : ''}</select>`;
  }
  if (info.tipo === 'canal') {
    return `<select class="r-valor" aria-label="Canal"><option value="whatsapp" ${valor !== 'instagram' ? 'selected' : ''}>WhatsApp</option>
      <option value="instagram" ${valor === 'instagram' ? 'selected' : ''}>Instagram</option></select>`;
  }
  if (info.tipo === 'data') {
    return `<span class="r-dias"><input class="r-valor" type="number" min="1" step="1" value="${v || 30}" aria-label="Dias"> dias</span>`;
  }
  return `<input class="r-valor" value="${v}" aria-label="Valor" placeholder="digite o valor">`;
}

function coletarRegras() {
  sincronizarAvancadas();
  return condicoesParaRegras(sgCondicoes, { somenteCompletas: true });
}

function agendarPreviaSeg() {
  clearTimeout(timerPreviaSeg);
  timerPreviaSeg = setTimeout(previaSegmento, 300);
}

async function previaSegmento() {
  const caixa = el('#sg-previa');
  if (!caixa) return;
  const regras = coletarRegras();
  try {
    const p = await api.post('/api/segmentos/previa', { regras });
    const fora = p.total - p.elegiveis;
    const frac = p.total ? p.elegiveis / p.total : 0;
    caixa.innerHTML = `
      <div class="sg-numeros">
        <div><strong>${p.elegiveis}</strong><span>recebem (opt-in)</span></div>
        <div><strong>${fora}</strong><span>sem opt-in</span></div>
        <div><strong>${p.total}</strong><span>no total</span></div>
      </div>
      <div class="sg-barra-linha"><span class="sg-barra sg-barra-larga" title="${p.elegiveis} de ${p.total} com opt-in">
        <span style="width:${(frac * 100).toFixed(1)}%"></span></span><span class="mk-dim">${pct(frac)} com opt-in</span></div>
      ${p.amostra.length ? `<h4>Alguns contatos</h4><ul class="sg-amostra">${p.amostra.map((x) => `
        <li><button type="button" class="cp-envio-nome" data-contato="${x.id}">${escapar(x.display_name || formatarTelefone(x.phone))}</button>
          <span class="mk-badge ${x.elegivel ? 'mk-badge-ok' : 'mk-badge-warn'}">${x.elegivel ? 'opt-in' : 'sem opt-in'}</span>
          ${x.interesse_declarado ? `<span class="sg-amostra-int">${escapar(x.interesse_declarado)}</span>` : ''}</li>`).join('')}</ul>
        ${p.total > p.amostra.length ? `<p class="mk-dim">… e mais ${p.total - p.amostra.length}.</p>` : ''}`
        : '<p class="mk-dim">Nenhum contato atende a essas condições.</p>'}
      <p class="fc-sub sg-dica">Atualiza enquanto você monta as condições.</p>`;
    caixa.querySelectorAll('[data-contato]').forEach((b) => b.addEventListener('click', () => abrirFicha(b.dataset.contato)));
  } catch (err) {
    caixa.innerHTML = `<p class="fc-msg fc-msg-erro">${escapar(err.message)}</p>`;
  }
}

// ============================================================== modelos ====
let modeloAtual = null;
let contatosPrevia = [];

async function carregarModelos() {
  const modelos = await api.get('/api/modelos');
  cacheModelos = modelos;
  const caixa = el('#lista-modelos');
  if (!modelos.length) {
    caixa.innerHTML = `<div class="mk-vazio"><p>Nenhum modelo ainda. O modelo é o texto da campanha, com campos
      que viram o nome, os interesses ou o link de cada cliente.</p>
      <button type="button" class="mk-btn" data-novo>Criar o primeiro modelo</button></div>`;
    caixa.querySelector('[data-novo]').addEventListener('click', () => abrirModelo(null));
    return;
  }
  caixa.innerHTML = modelos.map((m) => {
    const a = APROVACAO[m.situacao_aprovacao] || { texto: m.situacao_aprovacao, classe: '' };
    const params = parametrosDe(m);
    return `
      <div class="mk-card fc-item md-item" data-modelo="${m.id}" tabindex="0" role="button" aria-label="Abrir modelo ${escapar(m.nome)}">
        <div class="fc-avatar fc-avatar-sm mk-ico" aria-hidden="true">${ICONE.modelo}</div>
        <div class="fc-item-info">
          <div class="mk-card-title">${escapar(m.nome)} <span class="mk-badge ${a.classe}">${a.texto}</span>
            ${m.total_campanhas ? `<span class="mk-badge">${m.total_campanhas} ${m.total_campanhas === 1 ? 'campanha' : 'campanhas'}</span>` : ''}</div>
          <div class="md-trecho">${formatarWhats(corpoComRotulos(m.corpo, params).replace(/\s*\n+\s*/g, ' '))}</div>
        </div>
        <span class="fc-item-abrir">Abrir →</span>
      </div>`;
  }).join('');
  cardClicavel(caixa, '[data-modelo]', (card) => abrirModelo(card.dataset.modelo));
}

el('#novo-modelo').addEventListener('click', () => abrirModelo(null));

// Atualiza a situação de aprovação dos modelos com o que está na Meta.
el('#sincronizar-modelos').addEventListener('click', async (ev) => {
  const botao = ev.currentTarget;
  const caixa = el('#aviso-modelos');
  botao.disabled = true;
  botao.textContent = 'Sincronizando…';
  try {
    const r = await api.post('/api/modelos/sincronizar-meta');
    const partes = [r.atualizados.length
      ? `Atualizados: ${r.atualizados.map((a) => `${a.nome} → ${(APROVACAO[a.para] || {}).texto || a.para}`).join(', ')}.`
      : 'A situação dos modelos já estava igual à da Meta.'];
    if (r.sem_correspondencia.length) partes.push(`Sem modelo com o mesmo nome na Meta: ${r.sem_correspondencia.join(', ')}.`);
    if (r.so_na_meta.length) partes.push(`Existem só na Meta (cadastre aqui com o mesmo nome para usar): ${r.so_na_meta.join(', ')}.`);
    caixa.innerHTML = `<div class="fc-aviso" role="status">${escapar(partes.join(' '))}</div>`;
    carregarModelos();
  } catch (err) {
    caixa.innerHTML = `<div class="fc-aviso fc-aviso-erro" role="alert">${escapar(err.message)}</div>`;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Sincronizar com a Meta';
  }
});

const IDIOMAS = { pt_BR: 'Português (Brasil)', es: 'Espanhol', en_US: 'Inglês (EUA)' };
const ORDEM_PARAMS = ['primeiro_nome', 'display_name', 'interesse_declarado', 'perfil', 'nivel_engajamento', 'phone', '_link'];

function normalizarNomeMeta(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 512);
}

// Maior {{n}} usado no corpo e se a sequência tem buracos ({{1}} e {{3}} sem {{2}}).
function variaveisDoCorpo(corpo) {
  const usados = new Set([...String(corpo || '').matchAll(/\{\{(\d+)\}\}/g)].map((x) => Number(x[1])));
  const maior = usados.size ? Math.max(...usados) : 0;
  const faltam = [];
  for (let i = 1; i <= maior; i += 1) if (!usados.has(i)) faltam.push(i);
  return { maior, faltam };
}

async function abrirModelo(id, aviso) {
  const d = janela('dlg-modelo');
  const caixa = el('#dlg-modelo-conteudo');
  caixa.innerHTML = CARREGANDO;
  const [modelo, metaMod, contatos] = await Promise.all([
    id ? api.get(`/api/modelos/${id}`) : null,
    api.get('/api/modelos/metadados'),
    contatosPrevia.length ? contatosPrevia : api.get('/api/contatos').catch(() => []),
  ]);
  contatosPrevia = contatos;
  const permitidos = ORDEM_PARAMS.filter((p) => p === 'primeiro_nome' || metaMod.atributos.includes(p));
  modeloAtual = modelo || { id: null, nome: '', idioma: 'pt_BR', corpo: '', parametros: '[]', situacao_aprovacao: 'rascunho' };
  const params = parametrosDe(modeloAtual);
  const usos = id ? (cacheModelos.find((m) => m.id === Number(id)) || {}).total_campanhas || 0 : 0;
  const idiomas = { ...IDIOMAS };
  if (modeloAtual.idioma && !idiomas[modeloAtual.idioma]) idiomas[modeloAtual.idioma] = modeloAtual.idioma;

  caixa.innerHTML = `
    ${cabecalho({
      icone: ICONE.modelo, idTitulo: 'md-titulo',
      titulo: modelo ? modelo.nome : 'Novo modelo',
      sub: 'O texto da campanha. Os campos viram os dados de cada cliente no envio.',
    })}
    ${aviso ? `<div class="fc-aviso" role="status">${escapar(aviso)}</div>` : ''}
    <form id="md-form" class="fc-body" novalidate>
      <div class="fc-col">
        <section class="fc-bloco fc-form">
          <div class="fc-grid2">
            <label>Nome na Meta <input name="nome" value="${escapar(modeloAtual.nome)}" maxlength="512" required placeholder="promo_lentes_novembro"></label>
            <label>Idioma <select name="idioma">${Object.entries(idiomas).map(([k, v]) => `<option value="${k}" ${k === modeloAtual.idioma ? 'selected' : ''}>${escapar(v)}</option>`).join('')}</select></label>
          </div>
          <p class="fc-sub md-dica-nome">Igual ao cadastrado na Meta: letras minúsculas, números e _ (ajustado sozinho).</p>
          <div>
            <span class="md-rotulo">Situação na Meta</span>
            <div class="fc-seg md-seg4" role="radiogroup" aria-label="Situação de aprovação">
              ${['rascunho', 'pendente', 'aprovado', 'rejeitado'].map((s) => `<label><input type="radio" name="situacao_aprovacao" value="${s}"
                ${s === modeloAtual.situacao_aprovacao ? 'checked' : ''}><span data-s="${s}">${APROVACAO[s].texto}</span></label>`).join('')}
            </div>
            <p class="fc-sub md-dica-aprov">Só modelos <strong>aprovados</strong> podem ser disparados (a Meta exige).</p>
          </div>
        </section>
        <section class="fc-bloco fc-form">
          <div class="md-corpo-topo"><span class="md-rotulo">Texto da mensagem</span><span class="md-contagem" id="md-contagem"></span></div>
          <div class="md-inserir" role="group" aria-label="Inserir campo do cliente">
            <span class="mk-dim">Inserir:</span>
            ${permitidos.map((p) => `<button type="button" class="fc-int" data-inserir="${p}"><span class="fc-int-ico">+</span>${PARAM_ROTULO[p] || p}</button>`).join('')}
          </div>
          <textarea name="corpo" rows="7" maxlength="1024" aria-label="Texto da mensagem"
            placeholder="Oi {{1}}! Chegaram lentes novas que combinam com você: {{2}}&#10;&#10;Responda SAIR para não receber mais.">${escapar(modeloAtual.corpo)}</textarea>
          <div id="md-variaveis"></div>
          <ul class="md-checagens" id="md-checagens"></ul>
        </section>
        <div class="fc-form-acoes">
          <button type="submit" class="mk-btn">${modelo ? 'Salvar modelo' : 'Criar modelo'}</button>
          ${modelo ? '<button type="button" class="fc-link fc-link-perigo" data-excluir-mod>Excluir modelo</button>' : ''}
          <p class="fc-msg" role="status" aria-live="polite"></p>
        </div>
        ${usos ? `<p class="fc-sub">Usado em ${usos} ${usos === 1 ? 'campanha' : 'campanhas'}.</p>` : ''}
      </div>
      <div class="fc-col">
        <section class="fc-bloco">
          <h3>Prévia no WhatsApp</h3>
          <label class="md-previa-com">Com os dados de
            <select name="previa_contato">${contatos.slice(0, 200).map((c) => `<option value="${c.id}">${escapar(c.display_name || formatarTelefone(c.phone))}</option>`).join('')}
              <option value="">um cliente sem dados</option></select></label>
          <div id="md-previa"></div>
        </section>
      </div>
    </form>`;
  ligarFechar(d);

  const form = el('#md-form');
  let mapa = [...params]; // atributo de cada {{n}}

  const desenharVariaveis = () => {
    const { maior } = variaveisDoCorpo(form.corpo.value);
    while (mapa.length < maior) mapa.push('primeiro_nome');
    el('#md-variaveis').innerHTML = maior ? `<div class="md-vars">${Array.from({ length: maior }, (_, i) => `
      <label class="md-var"><code>{{${i + 1}}}</code><span aria-hidden="true">→</span>
        <select data-var="${i}" aria-label="Campo da variável ${i + 1}">${permitidos.map((p) => `<option value="${p}" ${mapa[i] === p ? 'selected' : ''}>${PARAM_ROTULO[p] || p}</option>`).join('')}</select></label>`).join('')}</div>` : '';
    el('#md-variaveis').querySelectorAll('[data-var]').forEach((s) => s.addEventListener('change', () => {
      mapa[Number(s.dataset.var)] = s.value;
      atualizarPrevia();
    }));
  };

  const atualizarPrevia = () => {
    const corpo = form.corpo.value;
    const { maior, faltam } = variaveisDoCorpo(corpo);
    const usados = mapa.slice(0, maior);
    const contato = contatos.find((c) => c.id === Number(form.previa_contato.value)) || null;
    el('#md-previa').innerHTML = bolhaWhats(renderizarModelo(corpo, usados, contato),
      'Assim o cliente recebe. O link rastreado é criado na hora do envio.');
    el('#md-contagem').textContent = `${corpo.length}/1024`;
    const checks = [
      [/\b(sair|parar|cancelar)\b/i.test(corpo), 'Tem como o cliente sair (ex.: "Responda SAIR para não receber mais")', 'Inclua como sair: "Responda SAIR para não receber mais" (LGPD)'],
      [!faltam.length, 'Campos em sequência', `Faltam os campos ${faltam.map((n) => `{{${n}}}`).join(', ')}: use números em sequência a partir de {{1}}`],
      [usados.includes('_link'), 'Tem link rastreado: os cliques serão medidos', 'Sem link rastreado: os cliques não serão medidos'],
    ];
    el('#md-checagens').innerHTML = corpo.trim() ? checks.map(([ok, sim, nao], i) => `
      <li class="${ok ? 'is-ok' : i === 2 ? 'is-info' : 'is-alerta'}"><span aria-hidden="true">${ok ? '✓' : i === 2 ? 'i' : '!'}</span>${ok ? sim : nao}</li>`).join('') : '';
  };

  let cursor = null; // posição no texto antes de clicar num botão "Inserir"
  const guardarCursor = () => { cursor = [form.corpo.selectionStart, form.corpo.selectionEnd]; };
  ['blur', 'keyup', 'click', 'select'].forEach((e) => form.corpo.addEventListener(e, guardarCursor));
  form.corpo.addEventListener('input', () => { guardarCursor(); desenharVariaveis(); atualizarPrevia(); });
  form.previa_contato.addEventListener('change', atualizarPrevia);
  form.nome.addEventListener('blur', () => { form.nome.value = normalizarNomeMeta(form.nome.value); });
  form.querySelectorAll('[data-inserir]').forEach((b) => b.addEventListener('click', () => {
    // Insere {{próximo número}} no cursor e já liga ao campo escolhido.
    const t = form.corpo;
    const { maior } = variaveisDoCorpo(t.value);
    const n = maior + 1;
    mapa = mapa.slice(0, maior);
    mapa[n - 1] = b.dataset.inserir;
    const [ini, fim] = cursor || [t.value.length, t.value.length];
    const antes = t.value.slice(0, ini);
    const espaco = antes && !/\s$/.test(antes) ? ' ' : '';
    const trecho = `${espaco}{{${n}}}`;
    t.value = `${antes}${trecho}${t.value.slice(fim)}`;
    t.focus();
    t.selectionStart = t.selectionEnd = ini + trecho.length;
    guardarCursor();
    desenharVariaveis();
    atualizarPrevia();
  }));
  desenharVariaveis();
  atualizarPrevia();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = form.querySelector('.fc-form-acoes .fc-msg');
    msg.className = 'fc-msg fc-msg-erro';
    form.nome.value = normalizarNomeMeta(form.nome.value);
    if (!form.nome.value) { msg.textContent = 'Informe o nome do modelo (igual ao da Meta).'; form.nome.focus(); return; }
    if (!form.corpo.value.trim()) { msg.textContent = 'Escreva o texto da mensagem.'; form.corpo.focus(); return; }
    const { maior, faltam } = variaveisDoCorpo(form.corpo.value);
    if (faltam.length) { msg.textContent = `Use campos em sequência: falta ${faltam.map((n) => `{{${n}}}`).join(', ')}.`; return; }
    const corpo = {
      nome: form.nome.value,
      idioma: form.idioma.value,
      corpo: form.corpo.value,
      parametros: mapa.slice(0, maior),
      situacao_aprovacao: form.situacao_aprovacao.value,
    };
    try {
      let novoId = modeloAtual.id;
      if (novoId) await api.put(`/api/modelos/${novoId}`, corpo);
      else novoId = (await api.post('/api/modelos', corpo)).id;
      await carregarModelos();
      await abrirModelo(novoId, 'Modelo salvo.');
    } catch (err) { msg.textContent = err.message; }
  });
  const btnExcluir = caixa.querySelector('[data-excluir-mod]');
  if (btnExcluir) {
    confirmarNoBotao(btnExcluir, 'Excluir mesmo?', async () => {
      try {
        await api.del(`/api/modelos/${modelo.id}`);
        d.close();
        alerta(`Modelo "${modelo.nome}" excluído.`);
        carregarModelos();
      } catch (err) {
        const msg = form.querySelector('.fc-form-acoes .fc-msg');
        msg.className = 'fc-msg fc-msg-erro';
        msg.textContent = /409|usado/i.test(err.message) ? 'Não dá para excluir: há campanhas usando este modelo.' : err.message;
      }
    });
  }
}

// ========================================================== comparativo ====
// Duas séries fixas (paleta validada: azul = automatizado, laranja = manual),
// mesma escala para todas as taxas, valor na ponta de cada barra, legenda sempre
// visível e a tabela logo abaixo (os números exatos não dependem da cor).
const CENARIOS_CMP = [
  { chave: 'automatizado', rotulo: 'Automatizado', classe: 'cmp-auto' },
  { chave: 'manual', rotulo: 'Manual', classe: 'cmp-manual' },
];
const TAXAS_CMP = [
  ['taxa_entrega', 'Entrega'], ['taxa_leitura', 'Leitura'], ['taxa_resposta', 'Resposta'],
  ['taxa_clique', 'Clique'], ['taxa_conversao', 'Conversão'],
];

function pp(dif) {
  const v = (dif * 100).toFixed(1).replace('.', ',');
  return `${dif > 0 ? '+' : ''}${v} p.p.`;
}

async function carregarComparativo() {
  const [linhas, campanhas] = await Promise.all([api.get('/api/campanhas/comparativo'), api.get('/api/campanhas')]);
  cacheCampanhas = campanhas;
  const por = Object.fromEntries(linhas.map((l) => [l.cenario, l]));
  const caixa = el('#comparativo');
  if (!linhas.length) {
    caixa.innerHTML = `<div class="mk-vazio"><p>Ainda não há campanhas com envios para comparar. Dispare uma campanha
      automatizada e registre uma manual (linha de base) para ver a comparação aqui.</p></div>`;
    return;
  }
  const max = Math.max(0.1, ...linhas.flatMap((l) => TAXAS_CMP.map(([k]) => Number(l[k]) || 0)));
  const escala = Math.min(1, Math.ceil(max * 10) / 10);
  const falta = CENARIOS_CMP.filter((c) => !por[c.chave]);

  const cartoes = CENARIOS_CMP.map((c) => {
    const l = por[c.chave];
    return `<div class="cmp-cartao">
      <div class="cmp-cartao-topo"><span class="cmp-amostra ${c.classe}" aria-hidden="true"></span><strong>${c.rotulo}</strong></div>
      ${l ? `<div class="cmp-kpis">
        <div><strong>${l.campanhas}</strong><span>${l.campanhas === 1 ? 'campanha' : 'campanhas'}</span></div>
        <div><strong>${l.enviados}</strong><span>enviados</span></div>
        <div><strong>${segundos(l.tempo_medio_resposta)}</strong><span>até a resposta</span></div>
      </div>` : '<p class="mk-dim">Sem campanhas deste tipo ainda.</p>'}
    </div>`;
  }).join('');

  const barras = TAXAS_CMP.map(([k, rotulo]) => {
    const a = por.automatizado ? Number(por.automatizado[k]) || 0 : null;
    const m = por.manual ? Number(por.manual[k]) || 0 : null;
    const dif = a != null && m != null ? a - m : null;
    const barra = (v, c) => (v == null ? '' : `
      <div class="cmp-barra-linha" title="${c.rotulo} — ${rotulo}: ${pct(v)}">
        <span class="cmp-trilha">
          <span class="cmp-barra ${c.classe}" style="width:${v ? `max(2px, ${((v / escala) * 100).toFixed(1)}%)` : '0'}"></span>
          <span class="cmp-valor">${pct(v)}</span>
        </span>
      </div>`);
    return `<div class="cmp-metrica">
      <div class="cmp-metrica-topo"><span>${rotulo}</span>
        ${dif != null ? `<span class="cmp-dif">${Math.abs(dif) < 0.0005 ? 'empate' : `automatizado ${pp(dif)}`}</span>` : ''}</div>
      ${barra(a, CENARIOS_CMP[0])}${barra(m, CENARIOS_CMP[1])}
    </div>`;
  }).join('');

  const ranking = campanhas.filter((c) => Number(c.total_enviados) > 0)
    .sort((x, y) => (y.taxa_resposta || 0) - (x.taxa_resposta || 0));

  caixa.innerHTML = `
    <div class="cmp-cartoes">${cartoes}</div>
    <section class="mk-card cmp-grafico">
      <div class="cmp-grafico-topo">
        <h3>Taxas por tipo de campanha</h3>
        <div class="cmp-legenda" aria-label="Legenda">${CENARIOS_CMP.map((c) => `<span><span class="cmp-amostra ${c.classe}" aria-hidden="true"></span>${c.rotulo}</span>`).join('')}</div>
      </div>
      ${falta.length ? `<p class="mk-dim">Ainda não há campanhas ${falta.map((c) => c.rotulo.toLowerCase()).join(' e ')} com envios: a comparação fica completa quando houver os dois tipos.</p>` : ''}
      <div class="cmp-metricas">${barras}</div>
      <div class="cmp-eixo"><span>0%</span><span>${pct(escala)}</span></div>
      <details class="cmp-tabela">
        <summary>Ver os números em tabela</summary>
        <table class="mk-table">
          <thead><tr><th>Tipo</th><th>Campanhas</th><th>Enviados</th>${TAXAS_CMP.map(([, r]) => `<th>${r}</th>`).join('')}<th>Tempo médio</th></tr></thead>
          <tbody>${CENARIOS_CMP.filter((c) => por[c.chave]).map((c) => {
            const l = por[c.chave];
            return `<tr><td><strong>${c.rotulo}</strong></td><td>${l.campanhas}</td><td>${l.enviados}</td>
              ${TAXAS_CMP.map(([k]) => `<td>${pct(l[k])}</td>`).join('')}<td>${segundos(l.tempo_medio_resposta)}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </details>
    </section>
    <section class="mk-card cmp-ranking">
      <h3>Por campanha <span class="mk-dim">· ordenado pela taxa de resposta</span></h3>
      ${ranking.length ? `<div class="fc-tabela"><table class="mk-table">
        <thead><tr><th>Campanha</th><th>Tipo</th><th>Enviados</th><th>Resposta</th><th>Clique</th><th>Conversão</th><th>Tempo médio</th></tr></thead>
        <tbody>${ranking.map((c) => `
          <tr class="cmp-linha" data-campanha="${c.id}" tabindex="0" role="button" aria-label="Abrir campanha ${escapar(c.nome)}">
            <td>${escapar(c.nome)}</td>
            <td><span class="cmp-tipo"><span class="cmp-amostra ${c.cenario === 'automatizado' ? 'cmp-auto' : 'cmp-manual'}" aria-hidden="true"></span>${CENARIO[c.cenario] || c.cenario}</span></td>
            <td>${c.total_enviados}</td><td>${pct(c.taxa_resposta)}</td><td>${pct(c.taxa_clique)}</td>
            <td>${pct(c.taxa_conversao)}</td><td>${segundos(c.tempo_medio_resposta)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="mk-dim">Nenhuma campanha com envios ainda.</p>'}
    </section>`;
  cardClicavel(caixa, '[data-campanha]', (linha) => abrirCampanha(linha.dataset.campanha));
}

el('#recarregar-metricas').addEventListener('click', carregarComparativo);

carregarCampanhas().catch((err) => alerta(err.message, 'erro'));
