const encoder = new TextEncoder();
const DEFAULT_ORIGIN = 'https://zjsy.zhtianqi.cn';
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
let cachedSecret;
let cachedSigner;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

async function readDigests(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null;
  if (!request.body || Number(request.headers.get('Content-Length') || 0) > 256) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || Array.isArray(data) || Object.keys(data).length !== 2 ||
        typeof data.watermarkDigest !== 'string' || !DIGEST_PATTERN.test(data.watermarkDigest) ||
        typeof data.imageDigest !== 'string' || !DIGEST_PATTERN.test(data.imageDigest)) return null;
    return { watermarkDigest: data.watermarkDigest, imageDigest: data.imageDigest };
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid_private_key');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function loadSigner(secret) {
  if (secret.length > 5000) throw new Error('signing_key_list_too_large');
  if (cachedSecret === secret && cachedSigner) return cachedSigner;
  cachedSecret = secret;
  cachedSigner = (async () => {
    const list = JSON.parse(secret);
    if (!list || Array.isArray(list) || typeof list !== 'object' ||
        Object.keys(list).length !== 2 || typeof list.activeKeyId !== 'string' ||
        !KEY_ID_PATTERN.test(list.activeKeyId) || !list.keys || Array.isArray(list.keys) || typeof list.keys !== 'object') throw new Error('invalid_key_list');
    const keyIds = Object.keys(list.keys);
    if (!keyIds.length || keyIds.length > 32 || !keyIds.includes(list.activeKeyId) ||
        !keyIds.every((id) => KEY_ID_PATTERN.test(id) && typeof list.keys[id] === 'string')) throw new Error('invalid_key_list');
    const keyBytes = decodeBase64(list.keys[list.activeKeyId]);
    const key = await crypto.subtle.importKey('pkcs8', keyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { keyId: list.activeKeyId, key };
  })();
  return cachedSigner;
}

async function signDigest(keyId, key, kind, digest) {
  const message = encoder.encode(`ZJSY-${kind}-proof/v2\n${keyId}\n${digest}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message));
  return btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/sign') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    // Origin checks reduce cross-site browser use, but this is a public issuer,
    // not an authentication mechanism or proof of the caller's identity.
    if (request.headers.get('Origin') !== (env.ZJSY_SITE_ORIGIN || DEFAULT_ORIGIN) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return response({ error: 'origin_not_allowed' }, 403);
    const digests = await readDigests(request);
    if (!digests) return response({ error: 'invalid_digest' }, 400);
    if (!env.ZJSY_SIGNING_KEYS) return response({ error: 'signing_unavailable' }, 503);
    try {
      const { keyId, key } = await loadSigner(env.ZJSY_SIGNING_KEYS);
      const [watermarkSignature, imageSignature] = await Promise.all([
        signDigest(keyId, key, 'watermark', digests.watermarkDigest),
        signDigest(keyId, key, 'image', digests.imageDigest),
      ]);
      // The request contains only two SHA-256 digests. No content is retained.
      return response({ keyId, watermarkSignature, imageSignature });
    } catch { return response({ error: 'signing_unavailable' }, 503); }
  },
};
