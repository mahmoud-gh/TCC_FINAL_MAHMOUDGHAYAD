// ===========================================================================
//  Cabeçalhos da API da Anthropic (Claude), usados pelo chatbot e pelo agente.
//
//  Chaves novas do Console (sk-ant-usr-... / sk-ant-svc-...) que não estão
//  presas a um workspace exigem também o cabeçalho anthropic-workspace-id.
//  Por isso: ANTHROPIC_WORKSPACE_ID=wrkspc_... no .env (aparece na tela da chave).
//  Chaves antigas (sk-ant-api03-...) não precisam dele.
// ===========================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Tira espaços e aspas que às vezes vêm junto ao colar no .env.
function limpar(valor) {
  return String(valor || '').trim().replace(/^['"]|['"]$/g, '').trim();
}

function chave() {
  return limpar(process.env.ANTHROPIC_API_KEY);
}

function workspace() {
  return limpar(process.env.ANTHROPIC_WORKSPACE_ID);
}

function cabecalhos() {
  const h = {
    'x-api-key': chave(),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (workspace()) h['anthropic-workspace-id'] = workspace();
  return h;
}

module.exports = { ANTHROPIC_API_URL, ANTHROPIC_VERSION, chave, workspace, cabecalhos };
