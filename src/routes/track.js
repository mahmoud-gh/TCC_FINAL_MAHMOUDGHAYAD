const express = require('express');
const campaignEngine = require('../services/campaignEngine');
const logger = require('../utils/logger');

const router = express.Router();

// A Cloud API notifica entrega, leitura e resposta, mas NÃO notifica clique.
// A taxa de clique só existe porque o endereço enviado na mensagem é este, que
// registra o acesso e redireciona ao destino original.
//
// `registrarClique` é assíncrona desde a migração para PostgreSQL. Sem o await,
// `destino` recebe a Promise — que é verdadeira — e o Express acaba mandando o
// navegador para "[object Promise]": o clique é contado, mas o redirecionamento
// não leva a lugar nenhum.
router.get('/:token', async (req, res) => {
  let destino = null;
  try {
    destino = await campaignEngine.registrarClique(req.params.token);
  } catch (err) {
    logger.error('Falha ao registrar clique:', err.message);
    return res.status(500).send('Não foi possível abrir este link.');
  }

  if (!destino) return res.status(404).send('Link inválido ou expirado.');
  res.redirect(302, destino);
});

module.exports = router;
