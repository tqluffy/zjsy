import { qrcodegen } from './vendor/qrcodegen.js';
import { VERIFICATION_KEYS } from './verification-keys.js';

export const VERIFY_URL = 'https://zjsy.zhtianqi.cn/verify/';
const VERIFY_ORIGIN = 'https://zjsy.zhtianqi.cn';
const PREFIX = VERIFY_URL + '#p=';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SIGNATURE_BYTES = 64;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
const FINGERPRINT_BYTES = 56;
const FINGERPRINT_SIDE = 32;
const PHASH_FREQUENCIES = 16;
const MARKER_MODULE_SIZE = 3;
export const IMAGE_MARKER_SIZE = MARKER_MODULE_SIZE * 9;
const MAX_PHASH_DISTANCE = 18;
const MAX_DHASH_DISTANCE = 8;
const MAX_CHROMA_ERROR = 32;
const MAX_CHROMA_COMPONENT_ERROR = 4;
const BYTE_POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  for (let bits = value; bits; bits &= bits - 1) count++;
  return count;
});
const DCT_COSINES = Array.from({ length: PHASH_FREQUENCIES }, (_, frequency) =>
  Float64Array.from({ length: FINGERPRINT_SIDE }, (_, position) =>
    Math.cos((2 * position + 1) * frequency * Math.PI / (2 * FINGERPRINT_SIDE))));
let footerCacheKey;
let footerCache;
let logoPromise;

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unbase64(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('二维码验证信息格式不正确。');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(bytes) { return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(''); }
async function hash(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

export function watermarkText(settings) {
  return [
    settings.purpose.trim(),
    settings.expiry ? '有效期至 ' + settings.expiry : '',
    settings.signature.trim() ? '签名：' + settings.signature.trim() : '',
  ].filter(Boolean).join('\n');
}

async function watermarkDigest(text) {
  return hex(await hash(encoder.encode(text + VERIFY_ORIGIN)));
}

function imageDescription(width, height, rect, markerSize) {
  return `${width}x${height}:${rect.x},${rect.y},${rect.width},${rect.height}:m${markerSize}`;
}

function imageFingerprint(source, rect) {
  const sample = document.createElement('canvas');
  sample.width = sample.height = FINGERPRINT_SIDE;
  try {
    const context = sample.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, FINGERPRINT_SIDE, FINGERPRINT_SIDE);
    const rgba = context.getImageData(0, 0, FINGERPRINT_SIDE, FINGERPRINT_SIDE).data;
    const luminance = new Float64Array(FINGERPRINT_SIDE * FINGERPRINT_SIDE);
    for (let pixel = 0, index = 0; index < rgba.length; index += 4, pixel++) {
      luminance[pixel] = rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114;
    }

    const coefficients = [];
    for (let v = 0; v < PHASH_FREQUENCIES; v++) for (let u = 0; u < PHASH_FREQUENCIES; u++) {
      if (u === 0 && v === 0) continue;
      let sum = 0;
      for (let y = 0; y < FINGERPRINT_SIDE; y++) {
        const yFactor = DCT_COSINES[v][y];
        const row = y * FINGERPRINT_SIDE;
        for (let x = 0; x < FINGERPRINT_SIDE; x++) sum += luminance[row + x] * DCT_COSINES[u][x] * yFactor;
      }
      coefficients.push(sum);
    }
    const sorted = coefficients.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const pHash = new Uint8Array(32);
    coefficients.forEach((value, bit) => { if (value > median) pHash[bit >>> 3] |= 1 << (7 - (bit & 7)); });

    const dHash = new Uint8Array(8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sampleY = Math.round(y * (FINGERPRINT_SIDE - 1) / 7);
      const leftX = Math.round(x * (FINGERPRINT_SIDE - 1) / 8);
      const rightX = Math.round((x + 1) * (FINGERPRINT_SIDE - 1) / 8);
      if (luminance[sampleY * FINGERPRINT_SIDE + leftX] > luminance[sampleY * FINGERPRINT_SIDE + rightX]) {
        const bit = y * 8 + x;
        dHash[bit >>> 3] |= 1 << (7 - (bit & 7));
      }
    }
    const chromaHash = new Uint8Array(16);
    for (let cellY = 0; cellY < 4; cellY++) for (let cellX = 0; cellX < 4; cellX++) {
      let cb = 0, cr = 0;
      for (let y = cellY * 8; y < cellY * 8 + 8; y++) for (let x = cellX * 8; x < cellX * 8 + 8; x++) {
        const index = (y * FINGERPRINT_SIDE + x) * 4;
        const red = rgba[index], green = rgba[index + 1], blue = rgba[index + 2];
        cb += 128 - red * 0.168736 - green * 0.331264 + blue * 0.5;
        cr += 128 + red * 0.5 - green * 0.418688 - blue * 0.081312;
      }
      const quantize = (value) => Math.max(0, Math.min(15, Math.round(value / 255 * 15)));
      chromaHash[cellY * 4 + cellX] = (quantize(cb / 64) << 4) | quantize(cr / 64);
    }
    const fingerprint = new Uint8Array(FINGERPRINT_BYTES);
    fingerprint.set(pHash);
    fingerprint.set(dHash, pHash.length);
    fingerprint.set(chromaHash, pHash.length + dHash.length);
    return fingerprint;
  } finally { sample.width = sample.height = 1; }
}

async function fingerprintDigest(fingerprint, canvasWidth, canvasHeight, rect, markerSize) {
  const descriptorDigest = hex(await hash(fingerprint));
  const description = imageDescription(canvasWidth, canvasHeight, rect, markerSize);
  return hex(await hash(encoder.encode('ZJSY-image-content/v3\n' + description + '\n' + descriptorDigest)));
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法准备验证图像，请尝试 PNG 或缩小照片。')), type, quality);
  });
}

async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('浏览器无法读取导出的图像。'));
      image.src = url;
    });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

async function imageFingerprintForExport(canvas, rect, format, quality) {
  if (format !== 'jpeg') return imageFingerprint(canvas, rect);
  // Fingerprint decoded JPEG pixels. The QR and corner markers are outside this region.
  const bitmap = await decodeBlob(await toBlob(canvas, 'image/jpeg', quality));
  try {
    return imageFingerprint(bitmap, rect);
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function normalizePacket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 3) throw new Error('不支持的二维码验证格式。');
  if (!KEY_ID_PATTERN.test(value.keyId || '')) throw new Error('二维码密钥 ID 格式不正确。');
  if (!value.watermark || typeof value.watermark !== 'object' || Array.isArray(value.watermark)) throw new Error('二维码缺少水印验证信息。');
  if (!value.image || typeof value.image !== 'object' || Array.isArray(value.image)) throw new Error('二维码缺少图像验证信息。');
  const text = value.watermark.text;
  if (typeof text !== 'string' || !text.trim() || encoder.encode(text).length > 1024) throw new Error('二维码中的水印文字无效或过长。');
  const watermarkHash = value.watermark.digest;
  const imageHash = value.image.digest;
  if (!DIGEST_PATTERN.test(watermarkHash || '') || !DIGEST_PATTERN.test(imageHash || '')) throw new Error('二维码摘要格式不正确。');
  const watermarkSignature = value.watermark.signature;
  const imageSignature = value.image.signature;
  if (unbase64(watermarkSignature).length !== SIGNATURE_BYTES || unbase64(imageSignature).length !== SIGNATURE_BYTES) throw new Error('二维码签名长度不正确。');
  const fingerprint = value.image.fingerprint;
  if (unbase64(fingerprint).length !== FINGERPRINT_BYTES) throw new Error('二维码图像指纹格式不正确。');
  const image = value.image;
  const dimensions = [image.canvasWidth, image.canvasHeight, image.x, image.y, image.width, image.height, image.markerSize];
  if (!dimensions.every((number) => Number.isInteger(number) && number >= 0 && number <= 16384)) throw new Error('二维码图像尺寸无效。');
  const [canvasWidth, canvasHeight, x, y, width, height, markerSize] = dimensions;
  if (!canvasWidth || !canvasHeight || !width || height < markerSize || markerSize !== IMAGE_MARKER_SIZE || canvasWidth * canvasHeight > 40_000_000 || width * height > 24_000_000 || x + width > canvasWidth || y + height > canvasHeight || x < markerSize || canvasWidth - (x + width) < markerSize) throw new Error('二维码图像区域无效。');
  return {
    watermark: { text, digest: watermarkHash, signature: watermarkSignature },
    image: { canvasWidth, canvasHeight, x, y, width, height, markerSize, fingerprint, digest: imageHash, signature: imageSignature },
    keyId: value.keyId,
    v: 3,
  };
}

function qrFor(packet) {
  return qrcodegen.QrCode.encodeText(PREFIX + base64(encoder.encode(JSON.stringify(packet))), qrcodegen.QrCode.Ecc.HIGH);
}

function placeholderPacket(text) {
  const signature = base64(new Uint8Array(SIGNATURE_BYTES));
  const fingerprint = base64(new Uint8Array(FINGERPRINT_BYTES));
  return {
    watermark: { text, digest: '0'.repeat(64), signature },
    image: { canvasWidth: 16384, canvasHeight: 16384, x: 16384, y: 16384, width: 16384, height: 16384, markerSize: IMAGE_MARKER_SIZE, fingerprint, digest: '0'.repeat(64), signature },
    keyId: VERIFICATION_KEYS[0].id,
    v: 3,
  };
}

export function footerLayout(width, bodyHeight, settings) {
  const text = watermarkText(settings);
  const key = JSON.stringify([width, bodyHeight, text]);
  if (key === footerCacheKey) return footerCache;
  let qr;
  try { qr = qrFor(placeholderPacket(text)); }
  catch { throw new Error('二维码内容过长，请缩短水印文字。'); }
  const qrSize = Math.ceil((qr.size + 8) * 3 / 8) * 8;
  if (qrSize + 32 > width) throw new Error('二维码宽度不足，请导出更大的图像。');
  const qrX = Math.floor((width - qrSize) / 2);
  const qrY = bodyHeight + 16;
  const height = Math.ceil((qrY + qrSize + 44) / 8) * 8;
  footerCacheKey = key;
  footerCache = { height, qrSize, qrX, qrY };
  return footerCache;
}

export function drawProofPlaceholder(context, layout, settings) {
  const geometry = footerLayout(layout.width, layout.bodyHeight, settings);
  context.save();
  context.fillStyle = '#fff';
  context.fillRect(0, layout.bodyHeight, layout.width, layout.height - layout.bodyHeight);
  context.strokeStyle = '#d6dbe7';
  context.strokeRect(geometry.qrX + 8, geometry.qrY + 8, geometry.qrSize - 16, geometry.qrSize - 16);
  context.fillStyle = '#858c9e';
  context.font = '12px sans-serif';
  context.textAlign = 'center';
  context.fillText('导出时生成二维码', geometry.qrX + geometry.qrSize / 2, geometry.qrY + geometry.qrSize / 2);
  context.fillStyle = '#7f8595';
  context.font = '11px sans-serif';
  context.fillText('扫码核验水印内容 · 选择图像核对主体', layout.width / 2, layout.height - 12);
  context.restore();
}

function drawQr(context, qr, geometry) {
  context.fillStyle = '#fff';
  context.fillRect(geometry.qrX, geometry.qrY, geometry.qrSize, geometry.qrSize);
  const moduleSize = 3;
  const actualSize = (qr.size + 8) * moduleSize;
  const left = geometry.qrX + Math.floor((geometry.qrSize - actualSize) / 2);
  const top = geometry.qrY + Math.floor((geometry.qrSize - actualSize) / 2);
  context.fillStyle = '#171923';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.getModule(x, y)) context.fillRect(left + (x + 4) * moduleSize, top + (y + 4) * moduleSize, moduleSize, moduleSize);
  }
  const badgeSize = Math.round(qr.size * 0.16) * moduleSize;
  const badgeX = left + (qr.size * moduleSize - badgeSize) / 2;
  const badgeY = top + (qr.size * moduleSize - badgeSize) / 2;
  context.fillStyle = '#fff';
  context.fillRect(badgeX - 2, badgeY - 2, badgeSize + 4, badgeSize + 4);
  context.strokeStyle = '#d8dbe4';
  context.lineWidth = 1;
  context.strokeRect(badgeX - 1.5, badgeY - 1.5, badgeSize + 3, badgeSize + 3);
  drawBrandLogo(context, currentSiteLogo(), badgeX + 3, badgeY + 3, badgeSize - 6);
}

function currentSiteLogo() {
  const image = document.querySelector('.brand img');
  return image?.complete && image.naturalWidth ? image : null;
}

function drawBrandLogo(context, image, x, y, size) {
  if (image) context.drawImage(image, x, y, size, size);
  else {
    context.fillStyle = '#5346d5';
    context.fillRect(x, y, size, size);
    context.fillStyle = '#fff';
    context.font = `700 ${Math.max(8, size * 0.62)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Z', x + size / 2, y + size / 2 + 0.5);
  }
}

export function prepareBrandAssets() {
  const image = document.querySelector('.brand img');
  if (!image) return Promise.resolve(null);
  if (image.complete) return Promise.resolve(image.naturalWidth ? image : null);
  if (!logoPromise) logoPromise = new Promise((resolve) => {
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => resolve(null), { once: true });
  });
  return logoPromise;
}

async function requestSign(watermarkHash, imageHash) {
  const result = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    body: JSON.stringify({ watermarkDigest: watermarkHash, imageDigest: imageHash }),
    signal: AbortSignal.timeout(20000),
  });
  if (!result.ok) throw new Error('本站签名暂不可用，未生成验证照片。可关闭验证后导出普通水印。');
  return result.json();
}

export async function addProof(canvas, layout, settings, format, quality) {
  if (!await prepareBrandAssets()) throw new Error('无法加载本站 Logo，二维码验证图像未生成。');
  const text = watermarkText(settings);
  const rect = { x: layout.imageX, y: layout.imageY, width: layout.imageWidth, height: layout.imageHeight };
  const [wmDigest, fingerprint] = await Promise.all([
    watermarkDigest(text),
    imageFingerprintForExport(canvas, rect, format, quality),
  ]);
  const imgDigest = await fingerprintDigest(fingerprint, canvas.width, canvas.height, rect, IMAGE_MARKER_SIZE);
  const signed = await requestSign(wmDigest, imgDigest);
  if (!signed || !VERIFICATION_KEYS.some((key) => key.id === signed.keyId)) throw new Error('本站签名密钥配置不一致，请稍后重试。');
  const packet = normalizePacket({
    v: 3,
    keyId: signed.keyId,
    watermark: { text, digest: wmDigest, signature: signed.watermarkSignature },
    image: {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      markerSize: IMAGE_MARKER_SIZE,
      fingerprint: base64(fingerprint),
      digest: imgDigest,
      signature: signed.imageSignature,
    },
  });
  const [watermarkValid, imageSignatureValid] = await Promise.all([verifyWatermark(packet), verifyImageSignature(packet)]);
  if (!watermarkValid || !imageSignatureValid) throw new Error('本站返回的签名无效，已停止导出。');
  const geometry = footerLayout(layout.width, layout.bodyHeight, settings);
  drawQr(canvas.getContext('2d'), qrFor(packet), geometry);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, layout.height - 28, layout.width, 28);
  context.fillStyle = '#7f8595';
  context.font = '11px sans-serif';
  context.textAlign = 'center';
  context.fillText('扫码核验水印内容 · 选择图像核对主体', layout.width / 2, layout.height - 12);
  return packet;
}

async function verifyDetached(domain, keyId, digest, signature) {
  const trusted = VERIFICATION_KEYS.find((key) => key.id === keyId);
  if (!trusted) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', trusted.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const message = encoder.encode(`ZJSY-${domain}-proof/v3\n${keyId}\n${digest}`);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64(signature), message);
  } catch { return false; }
}

export async function verifyWatermark(packet) {
  const calculated = await watermarkDigest(packet.watermark.text);
  return calculated === packet.watermark.digest && verifyDetached('watermark', packet.keyId, packet.watermark.digest, packet.watermark.signature);
}

export async function verifyImageSignature(packet) {
  const image = packet.image;
  const rect = { x: image.x, y: image.y, width: image.width, height: image.height };
  const calculated = await fingerprintDigest(unbase64(image.fingerprint), image.canvasWidth, image.canvasHeight, rect, image.markerSize);
  return calculated === image.digest && verifyDetached('image', packet.keyId, image.digest, image.signature);
}

function finderMarkerErrors(rgba, sampleWidth, x, y, size) {
  const moduleSize = size / 9;
  let errors = 0;
  for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const sampleX = x + Math.min(size - 1, Math.floor((col + 1.5) * moduleSize));
    const sampleY = y + Math.min(size - 1, Math.floor((row + 1.5) * moduleSize));
    const index = (sampleY * sampleWidth + sampleX) * 4;
    const gray = rgba[index] * 0.299 + rgba[index + 1] * 0.587 + rgba[index + 2] * 0.114;
    const expectedBlack = row === 0 || row === 6 || col === 0 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4);
    if ((gray < 128) !== expectedBlack) errors++;
  }
  return errors;
}

function locateFinderMarker(context, expectedX, expectedY, size, radius) {
  const canvas = context.canvas;
  const left = Math.max(0, expectedX - radius);
  const top = Math.max(0, expectedY - radius);
  const right = Math.min(canvas.width, expectedX + size + radius);
  const bottom = Math.min(canvas.height, expectedY + size + radius);
  const areaWidth = right - left;
  const areaHeight = bottom - top;
  if (size < 9 || areaWidth < size || areaHeight < size) return null;
  const rgba = context.getImageData(left, top, areaWidth, areaHeight).data;
  let best = null;
  for (let y = 0; y <= areaHeight - size; y++) for (let x = 0; x <= areaWidth - size; x++) {
    const errors = finderMarkerErrors(rgba, areaWidth, x, y, size);
    if (!best || errors < best.errors) best = { x: left + x, y: top + y, errors };
  }
  return best?.errors <= 6 ? best : null;
}

function locateImageRect(canvas, image, scaleX, scaleY) {
  if (Math.abs(scaleX / scaleY - 1) > 0.01) return null;
  const size = Math.round(image.markerSize * (scaleX + scaleY) / 2);
  if (size < 9) return null;
  const x = Math.round(image.x * scaleX);
  const y = Math.round(image.y * scaleY);
  const width = Math.round(image.width * scaleX);
  const height = Math.round(image.height * scaleY);
  const expected = [
    [x - size, y], [x + width, y],
    [x - size, y + height - size], [x + width, y + height - size],
  ];
  const radius = Math.max(1, Math.min(2, Math.ceil(size * 0.06)));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const found = expected.map(([left, top]) => locateFinderMarker(context, left, top, size, radius));
  if (found.some((marker) => !marker)) return null;
  if (found.some((marker, index) => Math.abs(marker.x - expected[index][0]) > 1 || Math.abs(marker.y - expected[index][1]) > 1)) return null;
  const [leftTop, rightTop, leftBottom, rightBottom] = found;
  const imageLeft = Math.round((leftTop.x + leftBottom.x) / 2) + size;
  const imageRight = Math.round((rightTop.x + rightBottom.x) / 2);
  const imageTop = Math.round((leftTop.y + rightTop.y) / 2);
  const imageBottom = Math.round((leftBottom.y + rightBottom.y) / 2) + size;
  const rect = { x: imageLeft, y: imageTop, width: imageRight - imageLeft, height: imageBottom - imageTop };
  if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) return null;
  return { rect, markerErrors: found.reduce((total, marker) => total + marker.errors, 0) };
}

function imageConfidence(pHashDistance, dHashDistance, chromaError, markerErrors) {
  const pHashSimilarity = 1 - pHashDistance / 256;
  const dHashSimilarity = 1 - dHashDistance / 64;
  const chromaSimilarity = 1 - chromaError / 480;
  const markerSimilarity = 1 - markerErrors / (4 * 49);
  return Math.round(100 * (0.4 * pHashSimilarity + 0.25 * dHashSimilarity + 0.25 * chromaSimilarity + 0.1 * markerSimilarity));
}

export async function verifyImage(canvas, packet) {
  const image = packet.image;
  const scaleX = canvas.width / image.canvasWidth;
  const scaleY = canvas.height / image.canvasHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX / scaleY - 1) > 0.01) {
    return { state: 'invalid', confidence: 0, reason: '图像比例变化过大，无法确认主体边界；裁切或非等比变形不支持。' };
  }
  const located = locateImageRect(canvas, image, scaleX, scaleY);
  if (!located) {
    return { state: 'invalid', confidence: 0, reason: '未能确认图像四周的定位块，无法确保摘要对应原始主体区域。' };
  }
  const { rect, markerErrors } = located;
  const actual = imageFingerprint(canvas, rect);
  const expected = unbase64(image.fingerprint);
  let pHashDistance = 0, dHashDistance = 0, chromaError = 0, maxChromaError = 0;
  for (let i = 0; i < 32; i++) pHashDistance += BYTE_POPCOUNT[expected[i] ^ actual[i]];
  for (let i = 32; i < 40; i++) dHashDistance += BYTE_POPCOUNT[expected[i] ^ actual[i]];
  for (let i = 40; i < FINGERPRINT_BYTES; i++) {
    const cbError = Math.abs((expected[i] >>> 4) - (actual[i] >>> 4));
    const crError = Math.abs((expected[i] & 15) - (actual[i] & 15));
    chromaError += cbError + crError;
    maxChromaError = Math.max(maxChromaError, cbError, crError);
  }
  const confidence = imageConfidence(pHashDistance, dHashDistance, chromaError, markerErrors);
  if (pHashDistance <= MAX_PHASH_DISTANCE && dHashDistance <= MAX_DHASH_DISTANCE && chromaError <= MAX_CHROMA_ERROR && maxChromaError <= MAX_CHROMA_COMPONENT_ERROR) {
    if (!pHashDistance && !dHashDistance && !chromaError) return { state: 'exact', confidence, reason: '本站签名有效，主体感知指纹完全一致。' };
    return { state: 'tolerant', confidence, reason: `主体感知指纹在轻微失真容差内匹配（pHash ${pHashDistance}/256，dHash ${dHashDistance}/64，色差 ${chromaError}/32）。` };
  }
  return { state: 'invalid', confidence: Math.min(49, confidence), reason: `主体感知指纹差异超出容差（pHash ${pHashDistance}/256，dHash ${dHashDistance}/64，色差 ${chromaError}/32）。` };
}

export function parsePacket(value) {
  let parsed;
  try { parsed = JSON.parse(decoder.decode(typeof value === 'string' ? unbase64(value) : value)); }
  catch { throw new Error('无法读取二维码验证信息。'); }
  return normalizePacket(parsed);
}

export function packetFromUrl(text) {
  const url = new URL(text);
  if (url.origin !== new URL(VERIFY_URL).origin || url.pathname !== '/verify/') throw new Error('二维码不是本站验证地址。');
  const value = new URLSearchParams(url.hash.slice(1)).get('p');
  if (!value) throw new Error('二维码没有包含验证信息。');
  return parsePacket(value);
}

function samePacket(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function readQr(canvas) {
  await import('./vendor/jsqr.js');
  for (const [left, top, width, height] of [[0.2, 0.55, 0.6, 0.45], [0, 0.5, 1, 0.5], [0, 0, 1, 1]]) {
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
  throw new Error('未读到新的本站验证二维码，请使用包含白边和二维码的完整图像。');
}

export { samePacket };
