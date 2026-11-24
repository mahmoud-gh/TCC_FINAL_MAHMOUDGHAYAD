require('dotenv').config();
const path = require('node:path');
const express = require('express');
const session = require('express-session');

const requireAuth = require('./src/middleware/requireAuth');
const requireAdmin = require('./src/middleware/requireAdmin');
const authRoutes = require('./src/routes/auth');
const webhookRoutes = require('./src/routes/webhooks');
const conversationRoutes = require('./src/routes/conversations');
const messageRoutes = require('./src/routes/messages');
const eventRoutes = require('./src/routes/events');
const flowRoutes = require('./src/routes/flows');
const userRoutes = require('./src/routes/users');
// [NOVO] módulo de marketing ativo (RF01–RF11)
const contactRoutes = require('./src/routes/contacts');
const segmentRoutes = require('./src/routes/segments');
const templateRoutes = require('./src/routes/templates');
const campaignRoutes = require('./src/routes/campaigns');
const trackRoutes = require('./src/routes/track');
const mediaRoutes = require('./src/routes/media');
const { startFlowScheduler } = require('./src/services/flowScheduler');
const { startCatalogScheduler } = require('./src/services/productCatalog');
const { startCampaignScheduler } = require('./src/services/campaignScheduler'); // [NOVO]
const logger = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-troque-isso',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// Webhooks da Meta não usam sessão/login — autenticados via verify token + assinatura.
app.use('/webhooks/meta', webhookRoutes);

// [NOVO] Redirecionamento de link rastreado: rota pública, acessada pelo próprio
// contato no celular — é o que permite medir a taxa de clique.
app.use('/r', trackRoutes);

app.use('/api', authRoutes);
app.use('/api/events', requireAuth, eventRoutes);
app.use('/api/conversations/:id/messages', requireAuth, messageRoutes);
app.use('/api/conversations', requireAuth, conversationRoutes);
app.use('/api/flows', requireAuth, requireAdmin, flowRoutes);
app.use('/api/users', requireAuth, userRoutes);

// [NOVO] Configuração e operação das campanhas: restrita a administradores.
app.use('/api/contatos', requireAuth, requireAdmin, contactRoutes);
app.use('/api/segmentos', requireAuth, requireAdmin, segmentRoutes);
app.use('/api/modelos', requireAuth, requireAdmin, templateRoutes);
app.use('/api/campanhas', requireAuth, requireAdmin, campaignRoutes);
// Mídia recebida pelo WhatsApp: baixada da Meta com o token, só para quem está logado.
app.use('/api/midia', requireAuth, mediaRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) {
    return res.status(404).json({ error: 'Não encontrado.' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  logger.info(`CRM de Atendimento rodando em http://localhost:${PORT}`);
  startFlowScheduler();
  startCatalogScheduler();
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    logger.info('Sem WHATSAPP_ACCESS_TOKEN no .env: os envios ao WhatsApp serão apenas simulados (modo dev).');
  }
  startCampaignScheduler(); // [NOVO]
});
