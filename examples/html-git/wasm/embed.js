'use strict';
const fs = require('node:fs');
const bytes = fs.readFileSync(process.argv[2]);
const html = fs.readFileSync('index.html', 'utf8');
const pattern = /const WASM_BASE64 = '[^']*';/;
const declaration = `const WASM_BASE64 = '${bytes.toString('base64')}';`;
if (!pattern.test(html)) throw new Error('The embedded wasm declaration is absent.');
if (process.argv[3] === '--check') {
  const embedded = Buffer.from(pattern.exec(html)[0].split("'")[1], 'base64');
  if (!bytes.equals(embedded)) throw new Error('The embedded wasm bytes differ from the source build.');
  console.log(`Verified ${bytes.length} embedded wasm bytes.`);
} else fs.writeFileSync('index.html', html.replace(pattern, declaration));
