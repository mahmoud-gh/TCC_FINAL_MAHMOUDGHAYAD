// RF07 — Personalização automatizada.
// O corpo do modelo usa a notação posicional da Meta ({{1}}, {{2}}, ...) e
// `parametros` é a lista ordenada de atributos do contato que os preenchem.
// O atributo especial `_link` recebe a URL rastreada gerada para aquele envio.

const ATRIBUTOS_PERMITIDOS = [
  'display_name',
  'perfil',
  'interesse_declarado',
  'nivel_engajamento',
  'phone',
  '_link',
];

function primeiroNome(valor) {
  if (!valor) return '';
  return String(valor).trim().split(/\s+/)[0];
}

function valorDoAtributo(atributo, contato, contexto) {
  if (atributo === '_link') return contexto.link || '';
  if (atributo === 'display_name') return contato.display_name || 'cliente';
  if (atributo === 'primeiro_nome') return primeiroNome(contato.display_name) || 'cliente';
  return contato[atributo] != null ? String(contato[atributo]) : '';
}

function parseParametros(modelo) {
  try {
    const lista = JSON.parse(modelo.parametros || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

/**
 * @returns {{texto: string, valores: string[], componentes: object[]}}
 */
function renderizar(modelo, contato, contexto = {}) {
  const atributos = parseParametros(modelo);

  for (const atributo of atributos) {
    if (!ATRIBUTOS_PERMITIDOS.includes(atributo) && atributo !== 'primeiro_nome') {
      throw new Error(`Parâmetro não permitido no modelo: ${atributo}`);
    }
  }

  const valores = atributos.map((atributo) => valorDoAtributo(atributo, contato, contexto));

  let texto = modelo.corpo || '';
  valores.forEach((valor, indice) => {
    texto = texto.split(`{{${indice + 1}}}`).join(valor);
  });

  const componentes = valores.length
    ? [{ type: 'body', parameters: valores.map((text) => ({ type: 'text', text })) }]
    : [];

  return { texto, valores, componentes };
}

module.exports = { renderizar, parseParametros, ATRIBUTOS_PERMITIDOS };
