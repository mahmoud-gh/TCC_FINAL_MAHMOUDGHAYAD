const express = require('express');
const { baixarMidia } = require('../services/whatsapp');
const logger = require('../utils/logger');

// Mídia recebida pelo WhatsApp (foto, áudio, documento...). A Meta só entrega
// o arquivo com o token de acesso, então o painel pede aqui e o servidor
// baixa na hora. Rota protegida por login (montada em server.js).
const router = express.Router();

router.get('/:mediaId', async (req, res) => {
  const { mediaId } = req.params;
  if (!/^\d{5,30}$/.test(mediaId)) return res.status(404).json({ error: 'Mídia não encontrada.' });

  try {
    const { conteudo, tipo } = await baixarMidia(mediaId);
    res.set('Content-Type', tipo);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(conteudo);
  } catch (err) {
    logger.error(`Falha ao baixar a mídia ${mediaId}:`, err.message);
    res.status(502).json({ error: 'Não foi possível baixar a mídia da Meta (ela fica disponível por até 30 dias).' });
  }
});

module.exports = router;
