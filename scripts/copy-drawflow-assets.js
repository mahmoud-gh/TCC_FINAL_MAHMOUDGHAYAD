const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'drawflow', 'dist');
const destDir = path.join(__dirname, '..', 'public', 'vendor', 'drawflow');

if (!fs.existsSync(srcDir)) {
  console.log('drawflow não encontrado em node_modules — rode "npm install" primeiro.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of ['drawflow.min.js', 'drawflow.min.css']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

console.log('Assets do Drawflow copiados para public/vendor/drawflow/');
