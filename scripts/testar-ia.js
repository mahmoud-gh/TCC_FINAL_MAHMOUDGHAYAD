require('dotenv').config();
const anthropic = require('../src/services/anthropic');

// ===========================================================================
//  Confere se a IA do chatbot (API da Anthropic) está funcionando.
//  Faz UMA chamada pequena (custo de fração de centavo) e explica o resultado.
//  Uso:  node scripts/testar-ia.js
//  A chave nunca é mostrada inteira — só o começo, o fim e o tamanho.
// ===========================================================================

(async () => {
  const chave = anthropic.chave();
  const workspace = anthropic.workspace();
  const modelo = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  console.log(`CHATBOT_IA: ${process.env.CHATBOT_IA || 'true'} | modelo: ${modelo}`);

  if (!chave) {
    console.log('\nSEM CHAVE: ANTHROPIC_API_KEY está vazia no .env desta pasta.');
    console.log('O chatbot está respondendo só pela busca direta ("Encontrei no catálogo: ...").');
    process.exit(1);
  }
  if ((process.env.CHATBOT_IA || 'true') === 'false') {
    console.log('\nCHATBOT_IA=false no .env: a IA está desligada de propósito.');
  }

  console.log(`Chave: ${chave.slice(0, 11)}…${chave.slice(-4)} (${chave.length} caracteres)`);
  console.log(`Workspace: ${workspace || '(não definido)'}`);

  // Erros de cópia que dá para pegar sem chamar a API.
  if (/\.\.\.|…/.test(chave)) {
    console.log('\nCHAVE MASCARADA: o que está no .env tem "..." no meio.');
    console.log('Isso é só a prévia que o Console mostra depois — não é a chave.');
    console.log('A chave inteira só aparece UMA vez, na hora em que você cria. Crie outra e copie na hora.');
    process.exit(1);
  }
  if (chave.length < 60) {
    console.log(`\nCHAVE CURTA DEMAIS (${chave.length} caracteres): uma chave inteira tem bem mais de 60.`);
    console.log('Provavelmente foi copiada pela metade. Crie outra no Console e copie com o botão de copiar.');
    process.exit(1);
  }
  if (/\s/.test(chave)) {
    console.log('\nA chave tem espaço ou quebra de linha no meio. Cole de novo, tudo em uma linha.');
    process.exit(1);
  }
  const chaveNova = /^sk-ant-(usr|svc)-/.test(chave);
  if (chaveNova && !workspace) {
    console.log('\nAviso: chave nova (sk-ant-usr/svc) sem ANTHROPIC_WORKSPACE_ID.');
    console.log('Se der erro de workspace abaixo, copie o wrkspc_... da tela da chave para o .env.');
  }

  const inicio = Date.now();
  const res = await fetch(anthropic.ANTHROPIC_API_URL, {
    method: 'POST',
    headers: anthropic.cabecalhos(),
    body: JSON.stringify({ model: modelo, max_tokens: 30, messages: [{ role: 'user', content: 'Responda só: IA funcionando.' }] }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));

  const corpo = await res.text();
  if (res.ok) {
    const json = JSON.parse(corpo);
    const texto = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    console.log(`\nOK em ${Date.now() - inicio} ms. Resposta: "${texto.trim()}"`);
    console.log('A IA está funcionando. No atendimento, as respostas dela aparecem com a etiqueta "🤖 IA".');
    console.log('Reinicie o sistema (npm run dev) para o chatbot pegar a chave nova.');
    process.exit(0);
  }

  let dica;
  if (/workspace/i.test(corpo) && /not scoped|must include/i.test(corpo)) {
    dica = 'Falta o workspace: coloque ANTHROPIC_WORKSPACE_ID=wrkspc_... no .env (está na tela da chave, em "Workspace").';
  } else if (/workspace/i.test(corpo)) {
    dica = 'Workspace errado: confira o ANTHROPIC_WORKSPACE_ID (copie de novo o wrkspc_... da tela da chave).';
  } else {
    dica = {
      0: 'Sem conexão com a internet (ou a rede bloqueia api.anthropic.com).',
      400: /credit|balance/i.test(corpo) ? 'Sem créditos: adicione saldo no Console → Billing.' : 'Pedido inválido — veja a mensagem abaixo.',
      401: 'Chave recusada: ela foi apagada, expirou ou não é a chave inteira. Crie outra no Console e cole a chave completa.',
      403: 'A chave não tem permissão para este modelo/workspace.',
      404: `Modelo "${modelo}" não encontrado: confira ANTHROPIC_MODEL no .env.`,
      429: 'Limite de uso atingido: espere um pouco ou aumente o limite no Console.',
      529: 'API sobrecarregada no momento: tente de novo em alguns minutos.',
    }[res.status] || 'Erro inesperado.';
  }
  console.log(`\nFALHOU (HTTP ${res.status}). ${dica}`);
  console.log(`Detalhe: ${corpo.slice(0, 300)}`);
  process.exit(1);
})();
