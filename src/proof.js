import { qrcodegen } from './vendor/qrcodegen.js';
import { encode, decode } from './ecc.js';
import { VERIFICATION_KEYS } from './verification-keys.js';

export const VERIFY_URL = 'https://zjsy.zhtianqi.cn/verify/';
const PREFIX = VERIFY_URL + '#p=';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const COEFFICIENTS = [[1, 0], [0, 1], [1, 1], [2, 0]];
let footerCacheKey;
let footerCache;
const BASES = COEFFICIENTS.map(([u, v]) => Float64Array.from({ length: 64 }, (_, i) => {
  const x = i % 8, y = Math.floor(i / 8);
  return (u ? 0.5 : Math.SQRT1_2 / 2) * (v ? 0.5 : Math.SQRT1_2 / 2) * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
}));

export function base64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unbase64(text) {
  if (text.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('验证信息格式不正确。');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}
function hex(bytes) { return Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join(''); }
function fromHex(text) { return Uint8Array.from(text.match(/../g), (n) => parseInt(n, 16)); }
async function hash(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
function equal(a, b) { return a.length === b.length && a.every((n, i) => n === b[i]); }

// The compact binary body keeps even long CJK statements small enough for a QR.
export function serializeBody(layout, settings, digest = new Uint8Array(32), descriptor = new Uint8Array(64), nonce = new Uint8Array(8)) {
  const purpose = encoder.encode(settings.purpose);
  const signature = encoder.encode(settings.signature);
  if (purpose.length > 400 || signature.length > 128) throw new Error('验证信息过长，请缩短用途或署名。');
  const bytes = new Uint8Array(132 + purpose.length + signature.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  const dimensions = [layout.width, layout.height, layout.bodyHeight, layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight];
  dimensions.forEach((n, i) => view.setUint16(1 + i * 2, n));
  bytes.set(nonce, 15);
  bytes.set(digest, 23);
  bytes.set(descriptor, 55);
  view.setUint16(119, purpose.length);
  const expiry = settings.expiry || '          ';
  bytes.set(encoder.encode(expiry), 121);
  bytes[131] = signature.length;
  bytes.set(purpose, 132);
  bytes.set(signature, 132 + purpose.length);
  return bytes;
}

function parseBody(bytes) {
  if (bytes.length < 132 || bytes[0] !== 1) throw new Error('不支持的验证格式。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = Array.from({ length: 7 }, (_, i) => view.getUint16(1 + i * 2));
  const [width, height, bodyHeight, imageX, imageY, imageWidth, imageHeight] = dimensions;
  const purposeSize = view.getUint16(119);
  const signatureSize = bytes[131];
  if (purposeSize > 400 || signatureSize > 128 || bytes.length !== 132 + purposeSize + signatureSize) throw new Error('验证信息长度不正确。');
  if (width < 640 || width > 16384 || height > 16384 || width * height > 40_000_000 || bodyHeight >= height || !imageWidth || !imageHeight || imageX + imageWidth > width || imageY + imageHeight > bodyHeight || imageWidth * imageHeight < 4080) throw new Error('验证图像尺寸不正确。');
  const purpose = decoder.decode(bytes.subarray(132, 132 + purposeSize));
  const signature = decoder.decode(bytes.subarray(132 + purposeSize));
  const expiry = decoder.decode(bytes.subarray(121, 131)).trim();
  if (!purpose.trim() || (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry))) throw new Error('验证用途或有效期格式不正确。');
  return { width, height, bodyHeight, imageX, imageY, imageWidth, imageHeight, purpose, expiry, signature, strict: bytes.slice(23, 55), descriptor: bytes.slice(55, 119) };
}

function envelope(body, keyId, issuedAt, signature) {
  const bytes = new Uint8Array(78 + body.length);
  bytes.set([90, 80]);
  bytes.set(fromHex(keyId), 2);
  new DataView(bytes.buffer).setUint32(10, issuedAt);
  bytes.set(signature, 14);
  bytes.set(body, 78);
  return bytes;
}

export function parsePacket(value) {
  const bytes = typeof value === 'string' ? unbase64(value) : value;
  if (bytes.length < 210 || bytes.length > 900 || bytes[0] !== 90 || bytes[1] !== 80) throw new Error('未识别到本站的验证凭据。');
  const body = bytes.slice(78);
  return { bytes, body, keyId: hex(bytes.subarray(2, 10)), issuedAt: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(10), signature: bytes.slice(14, 78), info: parseBody(body) };
}

export function packetFromUrl(text) {
  const url = new URL(text);
  if (url.origin !== new URL(VERIFY_URL).origin || url.pathname !== '/verify/') throw new Error('二维码不是本站验证地址。');
  const value = new URLSearchParams(url.hash.slice(1)).get('p');
  if (!value) throw new Error('二维码没有包含验证信息。');
  return parsePacket(value);
}

function qrFor(bytes) {
  return qrcodegen.QrCode.encodeText(PREFIX + base64(bytes), qrcodegen.QrCode.Ecc.MEDIUM);
}

export function footerLayout(width, bodyHeight, settings) {
  const key = JSON.stringify([width, bodyHeight, settings.purpose, settings.expiry, settings.signature]);
  if (key === footerCacheKey) return footerCache;
  // Binary fields have fixed lengths; placeholder data gives the final QR size.
  const dummy = { width, height: bodyHeight + 400, bodyHeight, imageX: 0, imageY: 0, imageWidth: width, imageHeight: bodyHeight };
  const packet = envelope(serializeBody(dummy, settings), VERIFICATION_KEYS[0].id, 0, new Uint8Array(64));
  const qr = qrFor(packet);
  const qrSize = (qr.size + 8) * 3;
  const columns = Math.floor((width - qrSize - 48) / 8);
  if (columns < 10) throw new Error('二维码内容过长，请缩短用途或署名。');
  const rows = Math.ceil(1020 / columns);
  const carrierY = Math.ceil((bodyHeight + 20) / 8) * 8;
  const height = Math.ceil(Math.max(bodyHeight + qrSize + 48, carrierY + rows * 8 + 32) / 8) * 8;
  footerCacheKey = key;
  footerCache = { height, qrSize, qrX: width - qrSize - 16, qrY: bodyHeight + 16, carrierX: 16, carrierY, columns, rows, carrierWidth: columns * 8, carrierHeight: rows * 8 };
  return footerCache;
}

export function drawProofPlaceholder(context, layout, settings) {
  const geometry = footerLayout(layout.width, layout.bodyHeight, settings);
  context.save();
  context.fillStyle = '#f8f9fc';
  context.fillRect(geometry.carrierX, geometry.carrierY, geometry.carrierWidth, geometry.carrierHeight);
  context.strokeStyle = '#d6dbe7';
  context.strokeRect(geometry.qrX + 8, geometry.qrY + 8, geometry.qrSize - 16, geometry.qrSize - 16);
  context.fillStyle = '#858c9e';
  context.font = '12px sans-serif';
  context.textAlign = 'center';
  context.fillText('下载时生成验证二维码', geometry.qrX + geometry.qrSize / 2, geometry.qrY + geometry.qrSize / 2);
  context.textAlign = 'left';
  context.fillText('主体隐写 + 白边纠错凭据', geometry.carrierX, layout.height - 12);
  context.restore();
}

async function contentHash(canvas, info) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const image = context.getImageData(0, 0, info.width, info.bodyHeight);
  // The reserved blue LSB is ignored; every other RGB bit and alpha is bound.
  for (let i = 2; i < image.data.length; i += 4) image.data[i] &= 254;
  return hash(image.data);
}

function descriptor(image, bodyHeight, fullHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 64, 64);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  context.drawImage(image, 0, 0, width, height * bodyHeight / fullHeight, 0, 0, 64, 64);
  const rgba = context.getImageData(0, 0, 64, 64).data;
  const result = new Uint8Array(64);
  for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
    let total = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = ((by * 8 + y) * 64 + bx * 8 + x) * 4;
      total += rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
    }
    result[by * 8 + bx] = Math.round(total / 64);
  }
  canvas.width = canvas.height = 1;
  return result;
}

function hiddenPayload(digest, packet) {
  const bytes = new Uint8Array(112);
  bytes.set([90, 74, 83, 49]);
  bytes.set(digest, 4);
  bytes.set(fromHex(packet.keyId), 36);
  new DataView(bytes.buffer).setUint32(44, packet.issuedAt);
  bytes.set(packet.signature, 48);
  return bytes;
}

function drawQr(context, qr, geometry) {
  context.fillStyle = '#fff';
  context.fillRect(geometry.qrX, geometry.qrY, geometry.qrSize, geometry.qrSize);
  context.fillStyle = '#171923';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.getModule(x, y)) context.fillRect(geometry.qrX + (x + 4) * 3, geometry.qrY + (y + 4) * 3, 3, 3);
  }
}

function embedDct(context, geometry, codeword) {
  const patch = context.createImageData(geometry.carrierWidth, geometry.carrierHeight);
  for (let p = 0; p < patch.data.length; p += 4) {
    patch.data[p] = patch.data[p + 1] = patch.data[p + 2] = 235;
    patch.data[p + 3] = 255;
  }
  for (let block = 0; block < 1020; block++) {
    const blockX = (block % geometry.columns) * 8;
    const blockY = Math.floor(block / geometry.columns) * 8;
    const values = BASES.map((_, i) => {
      const bit = (block * 4 + i) % 2040;
      return ((codeword[bit >>> 3] >>> (7 - (bit & 7))) & 1) ? 24 : -24;
    });
    for (let p = 0; p < 64; p++) {
      let value = 235;
      for (let i = 0; i < 4; i++) value += values[i] * BASES[i][p];
      const offset = ((blockY + Math.floor(p / 8)) * geometry.carrierWidth + blockX + p % 8) * 4;
      patch.data[offset] = patch.data[offset + 1] = patch.data[offset + 2] = Math.round(value);
    }
  }
  context.putImageData(patch, geometry.carrierX, geometry.carrierY);
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function carrierPositions(info, digest) {
  const pixels = info.imageWidth * info.imageHeight;
  let step = 104729 % pixels || 1;
  while (gcd(step, pixels) !== 1) step++;
  const start = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0) % pixels;
  return (i) => (start + i * step) % pixels;
}

function embedBody(context, info, digest, codeword) {
  const image = context.getImageData(info.imageX, info.imageY, info.imageWidth, info.imageHeight);
  const position = carrierPositions(info, digest);
  for (let i = 0; i < 4080; i++) {
    const bit = i % 2040;
    const index = position(i) * 4 + 2;
    image.data[index] = (image.data[index] & 254) | ((codeword[bit >>> 3] >>> (7 - (bit & 7))) & 1);
  }
  context.putImageData(image, info.imageX, info.imageY);
}

export async function addProof(canvas, layout, settings) {
  if (layout.imageWidth * layout.imageHeight < 4080) throw new Error('图像过小，无法在主体中容纳验证凭据。');
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const strict = await contentHash(canvas, layout);
  const visual = descriptor(canvas, layout.bodyHeight, layout.height);
  const body = serializeBody(layout, settings, strict, visual, nonce);
  const digest = await hash(body);
  const result = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    body: JSON.stringify({ digest: hex(digest) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!result.ok) throw new Error('本站签名暂不可用，未生成验证照片。可关闭验证后导出普通水印。');
  const signed = await result.json();
  if (!VERIFICATION_KEYS.some((key) => key.id === signed.keyId) || !Number.isInteger(signed.issuedAt) || typeof signed.signature !== 'string') throw new Error('本站签名配置不一致，请稍后重试。');
  const signature = unbase64(signed.signature);
  if (signature.length !== 64) throw new Error('本站签名格式错误。');
  const packet = parsePacket(envelope(body, signed.keyId, signed.issuedAt, signature));
  if (!await verifySignature(packet)) throw new Error('本站返回的签名无效，已停止导出。');
  const geometry = footerLayout(layout.width, layout.bodyHeight, settings);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const codeword = encode(hiddenPayload(digest, packet));
  drawQr(context, qrFor(packet.bytes), geometry);
  embedDct(context, geometry, codeword);
  embedBody(context, layout, digest, codeword);
  context.fillStyle = '#7f8595';
  context.font = '11px sans-serif';
  context.textAlign = 'left';
  context.fillText('本站签发 · 扫码查看用途并选择图像核对', geometry.carrierX, layout.height - 12);
  return packet;
}

export async function verifySignature(packet) {
  const trusted = VERIFICATION_KEYS.find((key) => key.id === packet.keyId);
  if (!trusted) return false;
  const key = await crypto.subtle.importKey('jwk', trusted.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const digest = hex(await hash(packet.body));
  const message = encoder.encode('ZJSY-site-proof/v1\n' + packet.keyId + '\n' + packet.issuedAt + '\n' + digest);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, packet.signature, message);
}

function recoverBody(canvas, info, digest, expected) {
  if (canvas.width !== info.width || canvas.height !== info.height) return false;
  const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(info.imageX, info.imageY, info.imageWidth, info.imageHeight).data;
  const position = carrierPositions(info, digest);
  for (let copy = 0; copy < 2; copy++) {
    const codeword = new Uint8Array(255);
    for (let bit = 0; bit < 2040; bit++) codeword[bit >>> 3] |= (rgba[position(bit + copy * 2040) * 4 + 2] & 1) << (7 - (bit & 7));
    try { if (equal(decode(codeword), expected)) return true; } catch { /* Try the other independent copy. */ }
  }
  return false;
}

function recoverDct(canvas, info, settings, expected) {
  const geometry = footerLayout(info.width, info.bodyHeight, settings);
  const patch = document.createElement('canvas');
  patch.width = geometry.carrierWidth;
  patch.height = geometry.carrierHeight;
  const context = patch.getContext('2d', { willReadFrequently: true });
  const sx = canvas.width / info.width, sy = canvas.height / info.height;
  context.drawImage(canvas, geometry.carrierX * sx, geometry.carrierY * sy, geometry.carrierWidth * sx, geometry.carrierHeight * sy, 0, 0, patch.width, patch.height);
  const rgba = context.getImageData(0, 0, patch.width, patch.height).data;
  try {
    for (let copy = 0; copy < 2; copy++) {
      const codeword = new Uint8Array(255);
      for (let block = 0; block < 510; block++) {
        const absolute = block + copy * 510;
        const x = absolute % geometry.columns * 8, y = Math.floor(absolute / geometry.columns) * 8;
        for (let frequency = 0; frequency < 4; frequency++) {
          let coefficient = 0;
          for (let p = 0; p < 64; p++) {
            const index = ((y + Math.floor(p / 8)) * patch.width + x + p % 8) * 4;
            coefficient += (rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114 - 235) * BASES[frequency][p];
          }
          const bit = block * 4 + frequency;
          if (coefficient > 0) codeword[bit >>> 3] |= 1 << (7 - (bit & 7));
        }
      }
      try { if (equal(decode(codeword), expected)) return true; } catch { /* Try the other copy. */ }
    }
    return false;
  } finally { patch.width = patch.height = 1; }
}

export async function verifyImage(canvas, packet) {
  if (!await verifySignature(packet)) return { state: 'invalid', reason: '签名不属于本站，或验证信息已被修改。' };
  const info = packet.info;
  const ratioDifference = Math.abs(canvas.width / canvas.height / (info.width / info.height) - 1);
  if (ratioDifference > 0.015) return { state: 'invalid', reason: '图像比例不匹配，可能发生了裁剪或拼接。' };
  const digest = await hash(packet.body);
  const expected = hiddenPayload(digest, packet);
  const bodyCarrier = recoverBody(canvas, info, digest, expected);
  const borderCarrier = recoverDct(canvas, info, info, expected);
  if (!bodyCarrier && !borderCarrier) return { state: 'unreadable', reason: '本站签名有效，但主体与白边的隐写凭据无法恢复，不能完成图像核对。' };
  if (canvas.width === info.width && canvas.height === info.height && equal(await contentHash(canvas, info), info.strict)) {
    return { state: 'exact', bodyCarrier, borderCarrier, reason: '本站签名与图像内容校验一致。主体、可见水印及白边声明均已绑定，隐写占用的蓝色最低位除外。' };
  }
  const current = descriptor(canvas, info.bodyHeight, info.height);
  const differences = Array.from(current, (n, i) => Math.abs(n - info.descriptor[i]));
  const average = differences.reduce((a, b) => a + b, 0) / 64;
  if (average <= 6 && Math.max(...differences) <= 24) return { state: 'similar', bodyCarrier, borderCarrier, reason: '本站签名有效，图像内容近似，可能经历了压缩或缩放。近似匹配不能证明细节未被修改。', difference: average };
  return { state: 'invalid', bodyCarrier, borderCarrier, reason: '本站签名存在，但图像内容不匹配；主体可能被替换或修改。' };
}

export async function readQr(canvas) {
  await import('./vendor/jsqr.js');
  // Prioritize the added bottom-right QR, avoiding an original document's QR.
  for (const [left, top, width, height] of [[0.4, 0.5, 0.6, 0.5], [0, 0.5, 1, 0.5], [0, 0, 1, 1]]) {
    const scan = document.createElement('canvas');
    const factor = Math.min(1, 2200 / canvas.width);
    scan.width = Math.round(canvas.width * width * factor);
    scan.height = Math.round(canvas.height * height * factor);
    const context = scan.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, canvas.width * left, canvas.height * top, canvas.width * width, canvas.height * height, 0, 0, scan.width, scan.height);
    const image = context.getImageData(0, 0, scan.width, scan.height);
    const qr = globalThis.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    scan.width = scan.height = 1;
    if (qr) {
      try { return packetFromUrl(qr.data); } catch { /* Ignore unrelated document QR codes. */ }
    }
  }
  throw new Error('未读到本站验证二维码。请使用完整图像，或扫描二维码进入验证页后再选择照片。');
}
