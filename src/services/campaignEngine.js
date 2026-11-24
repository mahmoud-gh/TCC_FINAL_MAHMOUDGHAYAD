const crypto = require('node:crypto');
const { stmt } = require('../db/stmt');
const consent = require('./consent');
const segmentation = require('./segmentation');
const { renderizar } = require('./templateRenderer');
const { sendWhatsAppTemplate, sendWhatsAppText } = require('./whatsapp');
const metrics = require('./campaignMetrics');
const logger = require('../utils/logger');

// RF05–RF09 e RF11 — Campanha.executar()
// Fluxo do diagrama de atividades da Seção 4.3.2: recupera segmento e modelo,
// itera sobre os contatos, verifica opt-in e revogação, personaliza, submete à
// Cloud API, grava o identificador retornado e registra falhas em vez de
// descartá-las silenciosamente.

const ATRASO_ENTRE_ENVIOS_MS = Number(process.env.CAMPAIGN_SEND_DELAY_MS || 350);
const JANELA_ATRIBUICAO_HORAS = Number(process.env.ATTRIBUTION_WINDOW_HOURS || 72);
const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const PALAVRAS_OPT_OUT = (process.env.OPTOUT_KEYWORDS || 'sair,parar,cancelar,descadastrar,stop,remover')
  .split(',')
  .map((p) => normalizar(p))
  .filter(Boolean);

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RF11 — registro de execução
// ---------------------------------------------------------------------------
async function abrirRegistro(fluxo, campanhaId) {
  const r = await stmt(
    'INSERT INTO registros_execucao_fluxo (fluxo, campanha_id) VALUES (?, ?)'
  ).run(fluxo, campanhaId || null);
  return Number(r.lastInsertRowid);
}

async function fecharRegistro(registroId, resultado, detalhe) {
  await stmt(`
    UPDATE registros_execucao_fluxo
    SET fim = now(), resultado = ?, detalhe = ?
    WHERE id = ?
  `).run(resultado, detalhe ? JSON.stringify(detalhe) : null, registroId);
}

// ---------------------------------------------------------------------------
// RF09 — eventos de interação (idempotentes pelo id_evento_api)
// ---------------------------------------------------------------------------
async function registrarEvento({ envioId, campanhaId, contactId, linkId, tipo, idEventoApi, payload }) {
  const r = await stmt(`
    INSERT INTO eventos_interacao
      (envio_id, campanha_id, contact_id, link_id, tipo, id_evento_api, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id_evento_api) DO NOTHING
  `).run(
    envioId || null,
    campanhaId || null,
    contactId,
    linkId || null,
    tipo,
    idEventoApi,
    payload ? JSON.stringify(payload) : null
  );
  return r.changes > 0; // false = notificação repetida, já contabilizada
}

// ---------------------------------------------------------------------------
// Execução da campanha automatizada
// ---------------------------------------------------------------------------
async function executarCampanha(campanhaId, opcoes = {}) {
  const campanha = await stmt('SELECT * FROM campanhas WHERE id = ?').get(campanhaId);
  if (!campanha) throw new Error('Campanha não encontrada.');
  if (campanha.situacao === 'em_execucao') throw new Error('Campanha já está em execução.');
  if (campanha.situacao === 'cancelada') throw new Error('Campanha cancelada.');
  if (campanha.cenario !== 'automatizado') {
    throw new Error(
      'Campanhas do cenário manual não são disparadas pelo motor: os envios são ' +
        'registrados pelo inbox, informando campanha_id na mensagem.'
    );
  }

  const modelo = await stmt('SELECT * FROM modelos_mensagem WHERE id = ?').get(campanha.modelo_id);
  if (!modelo) throw new Error('Modelo de mensagem não encontrado.');
  // RNF03 — comunicação proativa só por modelo previamente aprovado pela Meta.
  if (modelo.situacao_aprovacao !== 'aprovado') {
    throw new Error(
      `O modelo "${modelo.nome}" está como "${modelo.situacao_aprovacao}". ` +
        'Só modelos aprovados podem ser disparados.'
    );
  }

  const registroId = await abrirRegistro('execucao_campanha', campanhaId);
  await stmt("UPDATE campanhas SET situacao = 'em_execucao', updated_at = now() WHERE id = ?")
    .run(campanhaId);

  const resumo = { total: 0, enviados: 0, nao_elegiveis: 0, falhas: 0, ja_processados: 0 };

  try {
    const contatos = await segmentation.resolver(campanha.segmento_id, { plataforma: 'whatsapp' });
    resumo.total = contatos.length;

    for (const contato of contatos) {
      const jaExiste = await stmt(
        'SELECT id FROM envios WHERE campanha_id = ? AND contact_id = ?'
      ).get(campanhaId, contato.id);
      if (jaExiste) {
        resumo.ja_processados += 1;
        continue;
      }

      // RF06 — opt-in registrado e não revogado; as duas decisões do diagrama
      // de atividades resolvidas pela leitura da manifestação mais recente.
      if (!await consent.estaElegivel(contato.id)) {
        const ultima = await consent.ultimaManifestacao(contato.id);
        await stmt(`
          INSERT INTO envios (campanha_id, contact_id, situacao, motivo)
          VALUES (?, ?, 'nao_elegivel', ?)
        `).run(
          campanhaId,
          contato.id,
          ultima ? 'consentimento revogado (opt-out)' : 'sem opt-in registrado'
        );
        resumo.nao_elegiveis += 1;
        continue;
      }

      const token = campanha.url_destino ? crypto.randomUUID().replace(/-/g, '') : null;
      const linkRastreado = token ? `${BASE_URL}/r/${token}` : null;

      let render;
      try {
        render = renderizar(modelo, contato, { link: linkRastreado });
      } catch (err) {
        await stmt(`
          INSERT INTO envios (campanha_id, contact_id, situacao, motivo)
          VALUES (?, ?, 'falha', ?)
        `).run(campanhaId, contato.id, `personalização: ${err.message}`);
        resumo.falhas += 1;
        continue;
      }

      try {
        const resposta = await sendWhatsAppTemplate(
          contato.phone || contato.platform_user_id,
          modelo.nome,
          modelo.idioma,
          render.componentes
        );
        const idApi = resposta && resposta.messages && resposta.messages[0] && resposta.messages[0].id;

        const envioResult = await stmt(`
          INSERT INTO envios (campanha_id, contact_id, id_api, conteudo, situacao)
          VALUES (?, ?, ?, ?, 'enviado')
        `).run(campanhaId, contato.id, idApi || null, render.texto);
        const envioId = Number(envioResult.lastInsertRowid);

        if (token) {
          await stmt(`
            INSERT INTO links_rastreados (envio_id, token, url_destino) VALUES (?, ?, ?)
          `).run(envioId, token, campanha.url_destino);
        }

        await registrarEvento({
          envioId,
          campanhaId,
          contactId: contato.id,
          tipo: 'enviado',
          idEventoApi: `enviado:${idApi || `${campanhaId}:${contato.id}`}`,
        });

        resumo.enviados += 1;
      } catch (err) {
        await stmt(`
          INSERT INTO envios (campanha_id, contact_id, situacao, motivo)
          VALUES (?, ?, 'falha', ?)
        `).run(campanhaId, contato.id, String(err.message).slice(0, 500));
        await registrarEvento({
          campanhaId,
          contactId: contato.id,
          tipo: 'falha',
          idEventoApi: `falha:${campanhaId}:${contato.id}:${Date.now()}`,
          payload: { erro: err.message },
        });
        resumo.falhas += 1;
        logger.error(`Falha no envio da campanha ${campanhaId} ao contato ${contato.id}:`, err.message);
      }

      if (ATRASO_ENTRE_ENVIOS_MS > 0) await dormir(ATRASO_ENTRE_ENVIOS_MS);
    }

    await stmt("UPDATE campanhas SET situacao = 'concluida', updated_at = now() WHERE id = ?")
      .run(campanhaId);
    await fecharRegistro(registroId, 'concluida', resumo);
    await metrics.recalcular(campanhaId);
    return resumo;
  } catch (err) {
    await stmt("UPDATE campanhas SET situacao = 'agendada', updated_at = now() WHERE id = ?")
      .run(campanhaId);
    await fecharRegistro(registroId, 'falha', { erro: err.message, ...resumo });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cenário manual (linha de base): o operador envia pelo inbox informando a
// campanha; o envio é registrado com as mesmas regras de consentimento.
// ---------------------------------------------------------------------------
async function registrarEnvioManual({ campanhaId, contactId, conteudo, idApi, messageId }) {
  const campanha = await stmt('SELECT * FROM campanhas WHERE id = ?').get(campanhaId);
  if (!campanha) throw new Error('Campanha não encontrada.');
  if (campanha.cenario !== 'manual') {
    throw new Error('Só campanhas do cenário manual recebem envios registrados pelo inbox.');
  }
  // RNF02 — nenhum envio a contato sem consentimento vigente, inclusive no manual.
  if (!await consent.estaElegivel(contactId)) {
    throw new Error('Contato sem consentimento vigente (opt-in).');
  }

  const existente = await stmt(
    'SELECT id FROM envios WHERE campanha_id = ? AND contact_id = ?'
  ).get(campanhaId, contactId);
  if (existente) return existente.id;

  const r = await stmt(`
    INSERT INTO envios (campanha_id, contact_id, message_id, id_api, conteudo, situacao)
    VALUES (?, ?, ?, ?, ?, 'enviado')
  `).run(campanhaId, contactId, messageId || null, idApi || null, conteudo || null);
  const envioId = Number(r.lastInsertRowid);

  // Link rastreado também no cenário manual: sem ele a taxa de clique da linha
  // de base seria estruturalmente zero, e a comparação entre os cenários ficaria
  // enviesada pelo instrumento, não pela forma de execução. O operador copia
  // este endereço para a mensagem que envia pelo inbox.
  let linkRastreado = null;
  if (campanha.url_destino) {
    const token = crypto.randomUUID().replace(/-/g, '');
    await stmt(`
      INSERT INTO links_rastreados (envio_id, token, url_destino) VALUES (?, ?, ?)
    `).run(envioId, token, campanha.url_destino);
    linkRastreado = `${BASE_URL}/r/${token}`;
  }

  await registrarEvento({
    envioId,
    campanhaId,
    contactId,
    tipo: 'enviado',
    idEventoApi: `enviado:${idApi || `manual:${envioId}`}`,
  });
  await metrics.recalcular(campanhaId);
  return { envioId, linkRastreado };
}

// ---------------------------------------------------------------------------
// RF09 — status vindos do webhook (sent/delivered/read/failed)
// ---------------------------------------------------------------------------
const MAPA_STATUS = {
  sent: 'enviado',
  delivered: 'entregue',
  read: 'lido',
  failed: 'falha',
};

async function registrarStatusWebhook(status) {
  const tipo = MAPA_STATUS[status.status];
  if (!tipo) return false;

  const envio = await stmt('SELECT * FROM envios WHERE id_api = ?').get(status.platformMessageId);
  if (!envio) return false; // mensagem fora de campanha (atendimento comum)

  const novo = await registrarEvento({
    envioId: envio.id,
    campanhaId: envio.campanha_id,
    contactId: envio.contact_id,
    tipo,
    idEventoApi: `${tipo}:${status.platformMessageId}`,
    payload: status,
  });

  if (novo) await metrics.recalcular(envio.campanha_id);
  return novo;
}

// ---------------------------------------------------------------------------
// RF09 — resposta do contato atribuída ao envio mais recente dentro da janela
// ---------------------------------------------------------------------------
async function envioAtribuivel(contactId) {
  return await stmt(`
    SELECT * FROM envios
    WHERE contact_id = ?
      AND situacao = 'enviado'
      AND data_hora_envio >= (now() - (CAST(? AS INTEGER) * interval '1 hour'))
    ORDER BY data_hora_envio DESC, id DESC
    LIMIT 1
  `).get(contactId, JANELA_ATRIBUICAO_HORAS);
}

async function registrarResposta(contactId, payload) {
  const envio = await envioAtribuivel(contactId);
  if (!envio) return false;

  // `resposta:${envioId}` garante que só a PRIMEIRA resposta conte para a taxa.
  const novo = await registrarEvento({
    envioId: envio.id,
    campanhaId: envio.campanha_id,
    contactId,
    tipo: 'resposta',
    idEventoApi: `resposta:${envio.id}`,
    payload,
  });

  if (novo) await metrics.recalcular(envio.campanha_id);
  return novo;
}

// ---------------------------------------------------------------------------
// Clique (LinkRastreado) — a Cloud API não notifica cliques.
// ---------------------------------------------------------------------------
async function registrarClique(token) {
  const link = await stmt(`
    SELECT l.*, e.campanha_id, e.contact_id
    FROM links_rastreados l
    JOIN envios e ON e.id = l.envio_id
    WHERE l.token = ?
  `).get(token);
  if (!link) return null;

  await registrarEvento({
    envioId: link.envio_id,
    campanhaId: link.campanha_id,
    contactId: link.contact_id,
    linkId: link.id,
    tipo: 'clique',
    idEventoApi: `clique:${token}:${Date.now()}`,
  });
  await metrics.recalcular(link.campanha_id);
  return link.url_destino;
}

// ---------------------------------------------------------------------------
// Opt-out por palavra-chave no inbound (revogação imediata, sem penalização)
// ---------------------------------------------------------------------------
function ehPedidoDeOptOut(texto) {
  const limpo = normalizar(texto);
  if (!limpo) return false;
  return PALAVRAS_OPT_OUT.includes(limpo);
}

async function processarOptOut(contato, texto) {
  await consent.registrar({
    contactId: contato.id,
    tipo: 'opt_out',
    finalidade: consent.FINALIDADE_PADRAO,
    origem: `mensagem recebida no WhatsApp: "${String(texto).slice(0, 60)}"`,
  });

  const envio = await envioAtribuivel(contato.id);
  await registrarEvento({
    envioId: envio ? envio.id : null,
    campanhaId: envio ? envio.campanha_id : null,
    contactId: contato.id,
    tipo: 'opt_out',
    idEventoApi: `optout:${contato.id}:${Date.now()}`,
  });
  if (envio) await metrics.recalcular(envio.campanha_id);

  try {
    await sendWhatsAppText(
      contato.phone || contato.platform_user_id,
      'Pronto, seu cadastro foi removido das nossas campanhas. Você não receberá mais mensagens promocionais. Se quiser voltar, é só responder aqui.'
    );
  } catch (err) {
    logger.error('Falha ao confirmar opt-out:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Conversão — ocorre fora do canal, precisa ser registrada explicitamente.
// ---------------------------------------------------------------------------
async function registrarConversao({ envioId, valor, origem, observacao, usuarioId }) {
  const envio = await stmt('SELECT * FROM envios WHERE id = ?').get(envioId);
  if (!envio) throw new Error('Envio não encontrado.');
  if (envio.situacao !== 'enviado') throw new Error('Só envios efetivados geram conversão.');

  await stmt(`
    INSERT INTO conversoes (envio_id, campanha_id, contact_id, valor, origem, observacao, registrado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(envio_id) DO UPDATE SET
      valor = excluded.valor,
      origem = excluded.origem,
      observacao = excluded.observacao,
      data_hora = now()
  `).run(
    envioId,
    envio.campanha_id,
    envio.contact_id,
    valor != null ? Number(valor) : null,
    origem || 'manual',
    observacao || null,
    usuarioId || null
  );

  return await metrics.recalcular(envio.campanha_id);
}

module.exports = {
  executarCampanha,
  registrarEnvioManual,
  registrarStatusWebhook,
  registrarResposta,
  registrarClique,
  registrarConversao,
  registrarEvento,
  ehPedidoDeOptOut,
  processarOptOut,
  envioAtribuivel,
};
