const PALETTE = [
  '#4f8cff', // azul
  '#2ecc71', // verde
  '#f2b632', // amarelo
  '#e1306c', // rosa
  '#a55eea', // roxo
  '#ff7f50', // coral
  '#25d366', // verde-whatsapp
  '#00bcd4', // ciano
  '#ff5c5c', // vermelho
  '#8d6e63', // marrom
];

function colorForIndex(index) {
  return PALETTE[index % PALETTE.length];
}

module.exports = { PALETTE, colorForIndex };
