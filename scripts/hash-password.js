const { hashPassword } = require('../src/utils/password');

const password = process.argv[2];
if (!password) {
  console.error('Uso: node scripts/hash-password.js "minhasenha"');
  process.exit(1);
}

console.log('\nAdicione esta linha ao seu .env:\n');
console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}\n`);
