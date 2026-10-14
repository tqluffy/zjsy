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
let footerCacheKey;
let footerCache;

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

function imageDescription(width, height, rect) {
  return `${width}x${height}:${rect.x},${rect.y},${rect.width},${rect.height}`;
}

async function imageDigestFromPixels(pixels, canvasWidth, canvasHeight, rect) {
  const pixelDigest = hex(await hash(pixels));
  const description = imageDescription(canvasWidth, canvasHeight, rect);
  return hex(await hash(encoder.encode('ZJSY-image-content/v2\n' + description + '\n' + pixelDigest)));
}

async function imageDigest(canvas, rect) {
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(rect.x, rect.y, rect.width, rect.height).data;
  return imageDigestFromPixels(pixels, canvas.width, canvas.height, rect);
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

async function imageDigestForExport(canvas, rect, format, quality) {
  if (format !== 'jpeg') return imageDigest(canvas, rect);
  // Hash the decoded JPEG pixels. The QR is drawn later in the separate footer.
  const bitmap = await decodeBlob(await toBlob(canvas, 'image/jpeg', quality));
  const crop = document.createElement('canvas');
  crop.width = rect.width;
  crop.height = rect.height;
  try {
    crop.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
      .drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const pixels = crop.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, rect.width, rect.height).data;
    return imageDigestFromPixels(pixels, canvas.width, canvas.height, rect);
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
    crop.width = crop.height = 1;
  }
}

function normalizePacket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 2) throw new Error('不支持的二维码验证格式。');
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
  const image = value.image;
  const dimensions = [image.canvasWidth, image.canvasHeight, image.x, image.y, image.width, image.height];
  if (!dimensions.every((number) => Number.isInteger(number) && number >= 0 && number <= 16384)) throw new Error('二维码图像尺寸无效。');
  const [canvasWidth, canvasHeight, x, y, width, height] = dimensions;
  if (!canvasWidth || !canvasHeight || !width || !height || canvasWidth * canvasHeight > 40_000_000 || width * height > 24_000_000 || x + width > canvasWidth || y + height > canvasHeight) throw new Error('二维码图像区域无效。');
  return {
    watermark: { text, digest: watermarkHash, signature: watermarkSignature },
    image: { canvasWidth, canvasHeight, x, y, width, height, digest: imageHash, signature: imageSignature },
    keyId: value.keyId,
    v: 2,
  };
}

function qrFor(packet) {
  return qrcodegen.QrCode.encodeText(PREFIX + base64(encoder.encode(JSON.stringify(packet))), qrcodegen.QrCode.Ecc.MEDIUM);
}

function placeholderPacket(text) {
  const signature = base64(new Uint8Array(SIGNATURE_BYTES));
  return {
    watermark: { text, digest: '0'.repeat(64), signature },
    image: { canvasWidth: 16384, canvasHeight: 16384, x: 16384, y: 16384, width: 16384, height: 16384, digest: '0'.repeat(64), signature },
    keyId: VERIFICATION_KEYS[0].id,
    v: 2,
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
  const text = watermarkText(settings);
  const rect = { x: layout.imageX, y: layout.imageY, width: layout.imageWidth, height: layout.imageHeight };
  const [wmDigest, imgDigest] = await Promise.all([
    watermarkDigest(text),
    imageDigestForExport(canvas, rect, format, quality),
  ]);
  const signed = await requestSign(wmDigest, imgDigest);
  if (!signed || !VERIFICATION_KEYS.some((key) => key.id === signed.keyId)) throw new Error('本站签名密钥配置不一致，请稍后重试。');
  const packet = normalizePacket({
    v: 2,
    keyId: signed.keyId,
    watermark: { text, digest: wmDigest, signature: signed.watermarkSignature },
    image: {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
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
    const message = encoder.encode(`ZJSY-${domain}-proof/v2\n${keyId}\n${digest}`);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64(signature), message);
  } catch { return false; }
}

export async function verifyWatermark(packet) {
  const calculated = await watermarkDigest(packet.watermark.text);
  return calculated === packet.watermark.digest && verifyDetached('watermark', packet.keyId, packet.watermark.digest, packet.watermark.signature);
}

export function verifyImageSignature(packet) {
  return verifyDetached('image', packet.keyId, packet.image.digest, packet.image.signature);
}

export async function verifyImage(canvas, packet) {
  const image = packet.image;
  if (canvas.width !== image.canvasWidth || canvas.height !== image.canvasHeight) {
    return { state: 'invalid', reason: '图像尺寸不匹配，主体摘要无法通过精确核对。' };
  }
  const rect = { x: image.x, y: image.y, width: image.width, height: image.height };
  const calculated = await imageDigest(canvas, rect);
  if (calculated === image.digest) return { state: 'exact', reason: '本站签名有效，图像主体像素摘要一致。' };
  return { state: 'invalid', reason: '图像主体摘要不匹配，图像主体可能已被修改或重新编码。' };
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
