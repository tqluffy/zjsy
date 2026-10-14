import { webcrypto } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundlePathArg = process.argv[2];
if (!bundlePathArg) {
  console.error('Usage: node scripts/generate-signing-key.mjs /secure/path/signing-keys.json');
  process.exit(1);
}
const bundlePath = resolve(bundlePathArg);
const root = resolve('.');
if (bundlePath === root || bundlePath.startsWith(root + '/')) throw new Error('Keep private signing keys outside the repository.');

const idPattern = /^[0-9a-f]{16}$/;
let keyList = { activeKeyId: '', keys: {} };
try {
  keyList = JSON.parse(await readFile(bundlePath, 'utf8'));
  if (!keyList || Array.isArray(keyList) || Object.keys(keyList).length !== 2 ||
      !idPattern.test(keyList.activeKeyId || '') || !keyList.keys || Array.isArray(keyList.keys) || typeof keyList.keys !== 'object' ||
      !Object.keys(keyList.keys).length || !Object.keys(keyList.keys).every((id) => idPattern.test(id) && typeof keyList.keys[id] === 'string')) {
    throw new Error('Private key bundle must use {"activeKeyId":"...","keys":{"<keyId>":"<base64 PKCS#8>"}}.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
const keyId = Buffer.from(await webcrypto.subtle.digest('SHA-256', spki)).subarray(0, 8).toString('hex');
const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const privateKey = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
if (keyList.keys[keyId]) throw new Error('Generated key ID already exists in the private bundle.');
keyList = { activeKeyId: keyId, keys: { ...keyList.keys, [keyId]: privateKey } };
let prunedPrivateKeys = false;
if (Buffer.byteLength(JSON.stringify(keyList), 'utf8') > 5000) {
  // Old public keys, which verify historical QR codes, stay in the browser list.
  keyList = { activeKeyId: keyId, keys: { [keyId]: privateKey } };
  prunedPrivateKeys = true;
}

const temporary = bundlePath + '.tmp-' + process.pid;
try {
  await writeFile(temporary, JSON.stringify(keyList) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, bundlePath);
  await chmod(bundlePath, 0o600);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}

const publicKeyPath = resolve('src/verification-keys.js');
let previous = [];
try {
  const source = await readFile(publicKeyPath, 'utf8');
  previous = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!Array.isArray(previous) || previous.some((entry) => !idPattern.test(entry.id || '') || !entry.jwk)) throw new Error('Public verification key list is invalid.');
await writeFile(publicKeyPath, '// Public verification keys. Private signing keys must never be committed.\nexport const VERIFICATION_KEYS = ' + JSON.stringify([{ id: keyId, jwk }, ...previous.filter((entry) => entry.id !== keyId)], null, 2) + ';\n');

console.log('Generated public key ID: ' + keyId);
console.log('Private key bundle saved outside the repository: ' + bundlePath);
console.log('Upload the bundle as Cloudflare Secret ZJSY_SIGNING_KEYS. Older QR verification uses the public key list.');
if (prunedPrivateKeys) console.log('Older private keys were pruned to stay under Cloudflare’s 5 KB variable limit; historical public keys remain available.');
