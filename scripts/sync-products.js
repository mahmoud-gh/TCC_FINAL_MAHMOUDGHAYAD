require('dotenv').config();
const { syncProducts } = require('../src/services/productCatalog');

syncProducts()
  .then((count) => {
    console.log(`Sincronizados ${count} produtos.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Falha ao sincronizar produtos:', err.message);
    process.exit(1);
  });
