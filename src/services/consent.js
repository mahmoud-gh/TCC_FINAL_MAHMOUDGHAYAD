const { stmt } = require('../db/stmt');

// RF02 — Consentimento (LGPD, arts. 7º e 9º).
// Nenhuma manifestação é alterada ou removida: cada opt-in/opt-out gera um
// registro novo, datado, com finalidade e origem. A elegibilidade do contato é
// derivada da leitura da manifestação mais recente (Contato.estaElegivel()).

const FINALIDADE_PADRAO = 'campanhas de marketing via WhatsApp Business';

async function registrar({ contactId, tipo, finalidade, origem, observacao, usuarioId }) {
  if (!['opt_in', 'opt_out'].includes(tipo)) {
    throw new Error('Tipo de consentimento inválido: use opt_in ou opt_out.');
  }
  if (!origem) throw new Error('Origem da manifestação é obrigatória.');

  const result = await stmt(`
    INSERT INTO consentimentos (contact_id, tipo, finalidade, origem, observacao, registrado_por)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contactId,
    tipo,
    finalidade || FINALIDADE_PADRAO,
    origem,
    observacao || null,
    usuarioId || null
  );

  return Number(result.lastInsertRowid);
}

async function ultimaManifestacao(contactId) {
  return await stmt(`
    SELECT * FROM consentimentos
    WHERE contact_id = ?
    ORDER BY data_hora DESC, id DESC
    LIMIT 1
  `).get(contactId) || null;
}

// Contato.estaElegivel(): sem manifestação registrada, o contato é inelegível —
// a ausência de registro nunca é lida como consentimento presumido.
async function estaElegivel(contactId) {
  const ultima = await ultimaManifestacao(contactId);
  return Boolean(ultima && ultima.tipo === 'opt_in');
}

async function historico(contactId) {
  return await stmt(`
    SELECT c.*, u.name AS registrado_por_nome
    FROM consentimentos c
    LEFT JOIN users u ON u.id = c.registrado_por
    WHERE c.contact_id = ?
    ORDER BY c.data_hora DESC, c.id DESC
  `).all(contactId);
}

// Fragmento reutilizado pela segmentação para filtrar elegíveis em uma consulta só.
const SQL_ELEGIVEL = `
  (SELECT tipo FROM consentimentos k
    WHERE k.contact_id = contacts.id
    ORDER BY k.data_hora DESC, k.id DESC LIMIT 1) = 'opt_in'
`;

module.exports = {
  FINALIDADE_PADRAO,
  SQL_ELEGIVEL,
  registrar,
  ultimaManifestacao,
  estaElegivel,
  historico,
};
