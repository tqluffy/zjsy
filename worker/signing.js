const encoder = new TextEncoder();
const DEFAULT_ORIGIN = 'https://zjsy.zhtianqi.cn';
let cachedPrivateValue;
let cachedKey;

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

async function readDigest(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null;
  if (!request.body || Number(request.headers.get('Content-Length') || 0) > 128) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || Array.isArray(data) || Object.keys(data).length !== 1 || typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest)) return null;
    return data.digest;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/sign') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    // Origin checks reduce cross-site browser use, but this is a public issuer,
    // not an authentication mechanism or proof of the caller's identity.
    if (request.headers.get('Origin') !== (env.ZJSY_SITE_ORIGIN || DEFAULT_ORIGIN) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return response({ error: 'origin_not_allowed' }, 403);
    const digest = await readDigest(request);
    if (!digest) return response({ error: 'invalid_digest' }, 400);
    if (!env.ZJSY_SIGNING_PRIVATE_KEY || !env.ZJSY_SIGNING_KEY_ID) return response({ error: 'signing_unavailable' }, 503);
    try {
      if (cachedPrivateValue !== env.ZJSY_SIGNING_PRIVATE_KEY) {
        const bytes = Uint8Array.from(atob(env.ZJSY_SIGNING_PRIVATE_KEY.trim()), (character) => character.charCodeAt(0));
        cachedKey = crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        cachedPrivateValue = env.ZJSY_SIGNING_PRIVATE_KEY;
      }
      const keyId = env.ZJSY_SIGNING_KEY_ID;
      const issuedAt = Math.floor(Date.now() / 1000);
      const message = encoder.encode('ZJSY-site-proof/v1\n' + keyId + '\n' + issuedAt + '\n' + digest);
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await cachedKey, message);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      // No request logging, persistence, analytics or background tasks.
      return response({ keyId, issuedAt, signature: base64 });
    } catch { return response({ error: 'signing_unavailable' }, 503); }
  },
};
