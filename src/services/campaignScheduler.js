const { stmt } = require('../db/stmt');
const { executarCampanha } = require('./campaignEngine');
const logger = require('../utils/logger');

// RF05 — agendamento. Mesmo padrão do flowScheduler: varredura periódica,
// sem dependência externa de fila.

const INTERVALO_MS = Number(process.env.CAMPAIGN_SCHEDULER_INTERVAL_MS || 60000);

async function varrer() {
  let pendentes = [];
  try {
    pendentes = await stmt(`
      SELECT id FROM campanhas
      WHERE situacao = 'agendada'
        AND cenario = 'automatizado'
        AND agendamento IS NOT NULL
        AND agendamento <= now()
      ORDER BY agendamento
    `).all();
  } catch (err) {
    logger.error('Agendador de campanhas: falha ao consultar pendentes:', err.message);
    return;
  }

  for (const campanha of pendentes) {
    try {
      logger.info(`Disparando campanha agendada ${campanha.id}...`);
      const resumo = await executarCampanha(campanha.id);
      logger.info(`Campanha ${campanha.id} concluída:`, JSON.stringify(resumo));
    } catch (err) {
      logger.error(`Campanha ${campanha.id} falhou:`, err.message);
    }
  }
}

function startCampaignScheduler() {
  // É ele que dispara as campanhas agendadas. Pode ser desligado com
  // CAMPAIGN_SCHEDULER_ENABLED=false (as campanhas ficam só com o botão "Disparar").
  if (String(process.env.CAMPAIGN_SCHEDULER_ENABLED || 'true').toLowerCase() === 'false') {
    logger.info('Agendador de campanhas desativado (CAMPAIGN_SCHEDULER_ENABLED=false).');
    return;
  }

  setInterval(() => {
    varrer().catch((err) => logger.error('Erro no agendador de campanhas:', err));
  }, INTERVALO_MS);
  logger.info(`Agendador de campanhas ativo (intervalo ${INTERVALO_MS}ms).`);
}

module.exports = { startCampaignScheduler, varrer };
