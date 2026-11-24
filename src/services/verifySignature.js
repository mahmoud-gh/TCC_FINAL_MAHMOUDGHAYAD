const crypto = require('node:crypto');

function verifySignature(req, res, next) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    // [ALTERADO] RNF01: em produção, endpoint sem validação de assinatura
    // aceitaria qualquer POST. Só é liberado fora de produção, com aviso.
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).send('META_APP_SECRET não configurado.');
    }
    console.warn('[aviso] webhook sem validação de assinatura (META_APP_SECRET vazio).');
    return next();
  }

  const signatureHeader = req.get('x-hub-signature-256');
  if (!signatureHeader || !req.rawBody) {
    return res.status(401).send('Assinatura ausente.');
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return res.status(401).send('Assinatura inválida.');
  }

  next();
}

module.exports = verifySignature;
