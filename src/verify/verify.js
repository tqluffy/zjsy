import { packetFromUrl, readQr, verifyWatermark, verifyImageSignature, verifyImage, samePacket } from '../proof.js';

const $ = (id) => document.getElementById(id);
const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
let linkPacket = null;
let fileUrl = null;
let operation = 0;
const initialUrl = location.href;
if (location.hash) history.replaceState(null, '', location.pathname);

function result(state, title, detail) {
  $('verify-result').hidden = false;
  $('verify-result').className = 'verify-result ' + state;
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
}

async function showCredential(packet) {
  $('credential-card').hidden = false;
  $('claim-watermark').textContent = packet.watermark.text;
  $('claim-keyid').textContent = packet.keyId;
  $('claim-watermark-digest').textContent = packet.watermark.digest;
  $('claim-image-digest').textContent = packet.image.digest;
  $('claim-image-state').textContent = '正在核验本站签名…';
  $('claim-watermark-state').textContent = '正在核验文字与本站签名…';
  const [watermarkValid, imageSignatureValid] = await Promise.all([
    verifyWatermark(packet), verifyImageSignature(packet),
  ]);
  $('claim-watermark-state').textContent = watermarkValid
    ? '通过：二维码中的水印文字与本站签名一致。'
    : '未通过：水印文字摘要或本站签名无效。';
  $('claim-image-state').textContent = imageSignatureValid
    ? '签名有效；选择完整图像后核对主体内容。'
    : '未通过：图像摘要的本站签名无效。';
  return { watermarkValid, imageSignatureValid };
}

function clear() {
  operation++;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = null;
  $('verify-preview').removeAttribute('src');
  $('verify-preview').hidden = true;
  $('verify-result').hidden = true;
  $('verify-clear').hidden = true;
  $('verify-file-name').textContent = '';
  $('verify-input').value = '';
  if (!linkPacket) $('credential-card').hidden = true;
  $('verify-choose').disabled = false;
  $('verify-choose').textContent = '选择本地照片并核对';
}

async function load(file) {
  if (!file) return;
  clear();
  const version = operation;
  if (!allowed.has(file.type) || file.size > 30 * 1024 * 1024) {
    result('invalid', '文件不受支持', '请选择 30 MB 以内的 JPG、PNG、WebP 或 AVIF 图像。');
    return;
  }
  $('verify-choose').disabled = true;
  $('verify-choose').textContent = '正在本地核对…';
  $('verify-clear').hidden = false;
  $('verify-file-name').textContent = file.name || '粘贴的图像';
  fileUrl = URL.createObjectURL(file);
  const url = fileUrl;
  let image;
  let canvas;
  try {
    image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('图像无法读取，可能格式不受支持或文件已损坏。'));
      image.src = url;
    });
    if (version !== operation) return;
    const pixels = image.naturalWidth * image.naturalHeight;
    const budget = matchMedia('(pointer: coarse)').matches ? 12_000_000 : 40_000_000;
    if (pixels > budget || image.naturalWidth > 16384 || image.naturalHeight > 16384) throw new Error('图像超出此设备的安全核对尺寸，请使用电脑验证，或制作时选择最大长边 2048 px。');
    $('verify-preview').src = url;
    $('verify-preview').hidden = false;
    canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }).drawImage(image, 0, 0);
    let packet;
    try { packet = await readQr(canvas); }
    catch (error) { if (!linkPacket) throw error; packet = linkPacket; }
    if (version !== operation) return;
    if (linkPacket && !samePacket(packet, linkPacket)) throw new Error('这张图像的二维码与当前扫码链接不一致，请重新扫描图像中的二维码。');
    const credential = await showCredential(packet);
    if (version !== operation) return;
    if (!credential.watermarkValid || !credential.imageSignatureValid) {
      result('invalid', '二维码签名验证失败', '请不要依赖未经本站认可的验证信息。');
      return;
    }
    const verified = await verifyImage(canvas, packet);
    if (version !== operation) return;
    result(verified.state, verified.state === 'exact' ? '图像主体校验一致' : '图像主体核对未通过', verified.reason);
  } catch (error) {
    if (version === operation) result('invalid', '无法完成核对', error.message || '请使用包含完整白边和二维码的图像重试。');
  } finally {
    if (canvas) canvas.width = canvas.height = 1;
    if (image) image.removeAttribute('src');
    if (version === operation) {
      $('verify-choose').disabled = false;
      $('verify-choose').textContent = '选择另一张照片核对';
    }
  }
}

$('verify-choose').addEventListener('click', () => $('verify-input').click());
$('verify-input').addEventListener('change', () => load($('verify-input').files?.[0]));
$('verify-clear').addEventListener('click', clear);
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  load(event.dataTransfer.files[0]);
});
document.addEventListener('paste', (event) => {
  const item = Array.from(event.clipboardData?.items || []).find((value) => value.kind === 'file' && allowed.has(value.type));
  if (item) { event.preventDefault(); load(item.getAsFile()); }
});
window.addEventListener('pagehide', clear);

if (new URL(initialUrl).hash) {
  try {
    linkPacket = packetFromUrl(initialUrl);
    const credential = await showCredential(linkPacket);
    if (!credential.watermarkValid || !credential.imageSignatureValid) result('invalid', '二维码签名验证失败', '请不要依赖未经本站认可的验证信息。');
  } catch (error) { result('invalid', '二维码信息无法解析', error.message); }
}
