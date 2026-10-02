import { webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const privateOutput = process.argv[2];
if (!privateOutput) {
  console.error('Usage: node scripts/generate-signing-key.mjs /path/outside-repository/private-key.txt');
  process.exit(1);
}
const path = resolve(privateOutput);
const root = resolve('.');
if (path === root || path.startsWith(root + '/')) throw new Error('Keep the private key outside the repository.');
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', spki));
const id = digest.subarray(0, 8).toString('hex');
const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const privateKey = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
// Exclusive creation prevents accidentally replacing an existing backup.
await writeFile(path, privateKey + '\n', { flag: 'wx', mode: 0o600 });
const keyFile = 'src/verification-keys.js';
let previous = [];
try {
  const text = await readFile(keyFile, 'utf8');
  previous = JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;$/, ''));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(keyFile, '// Public verification keys. Private signing keys must never be committed.\nexport const VERIFICATION_KEYS = ' + JSON.stringify([{ id, jwk }, ...previous], null, 2) + ';\n');
console.log('Generated public key ID: ' + id);
console.log('Private key saved outside the repository. Set Cloudflare Secret ZJSY_SIGNING_PRIVATE_KEY from that file.');
