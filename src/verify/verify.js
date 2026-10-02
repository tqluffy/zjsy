import { packetFromUrl, readQr, verifySignature, verifyImage } from '../proof.js';

const $ = (id) => document.getElementById(id);
const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
let linkPacket = null;
let fileUrl = null;
let operation = 0;
const initialUrl = location.href;
// Remove the QR's personal metadata from this page's current history entry.
if (location.hash) history.replaceState(null, '', location.pathname);

function result(state, title, detail, carriers = '') {
  $('verify-result').hidden = false;
  $('verify-result').className = 'verify-result ' + state;
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  $('result-carriers').textContent = carriers;
}

async function showCredential(packet) {
  $('credential-card').hidden = false;
  $('claim-purpose').textContent = packet.info.purpose;
  $('claim-expiry').textContent = packet.info.expiry || '未设置';
  $('claim-signature').textContent = packet.info.signature || '未设置';
  $('claim-issued').textContent = new Date(packet.issuedAt * 1000).toLocaleString();
  const valid = await verifySignature(packet);
  $('claim-state').textContent = valid ? '本站签名有效；请选择照片，继续核对图像内容与隐写凭据。' : '签名无效或公钥未被本站认可，不能信任这些信息。';
  return valid;
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
    if (linkPacket && (packet.bytes.length !== linkPacket.bytes.length || !packet.bytes.every((n, i) => n === linkPacket.bytes[i]))) throw new Error('这张图像的二维码与当前扫码链接不一致，请重新扫描图像中的二维码。');
    if (!await showCredential(packet)) {
      result('invalid', '签名验证失败', '凭据可能被修改，或不属于本站签发。');
      return;
    }
    const verified = await verifyImage(canvas, packet);
    if (version !== operation) return;
    const titles = { exact: '本站签名与内容校验一致', similar: '本站签名有效 · 压缩后内容近似', invalid: '图像核对未通过', unreadable: '凭据无法完整恢复' };
    const carriers = verified.bodyCarrier !== undefined ? '主体隐写：' + (verified.bodyCarrier ? '已恢复' : '未恢复') + ' · 白边纠错隐写：' + (verified.borderCarrier ? '已恢复' : '未恢复') : '';
    result(verified.state, titles[verified.state], verified.reason, carriers);
  } catch (error) {
    if (version === operation) result('invalid', '无法完成核对', error.message || '请使用完整图像重新尝试。');
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
    if (!await showCredential(linkPacket)) result('invalid', '二维码签名无效', '请不要依赖未经本站认可的验证信息。');
  } catch (error) { result('invalid', '二维码信息无法解析', error.message); }
}
