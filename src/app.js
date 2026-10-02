import { createDemo, getLayout, randomSeed, render } from './render.js';

const $ = (id) => document.getElementById(id);
const form = $('settings');
const preview = $('preview-canvas');
const input = $('file-input');
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const objectUrls = new Set();
const stylePresets = {
  balanced: { opacity: 20, density: 5, fontSize: 2.8, angle: -28 },
  light: { opacity: 13, density: 3, fontSize: 2.4, angle: -28 },
  strong: { opacity: 33, density: 7, fontSize: 3.1, angle: -32 },
};
let source = null;
let sourceName = '';
let seed = randomSeed();
let demo = false;
let busy = false;
let loading = false;
let comparing = false;
let loadVersion = 0;
let pendingFrame = 0;
let statusTimer;
let dragDepth = 0;

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function defaultExpiry() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  $('expiry').value = localDate(date);
}

function notify(message, kind = '') {
  clearTimeout(statusTimer);
  $('status').textContent = message;
  $('status').className = 'toast' + (kind ? ' ' + kind : '');
  $('status').hidden = false;
  statusTimer = setTimeout(() => { $('status').hidden = true; }, kind === 'error' ? 8000 : 4500);
}

function revokeUrl(url) {
  URL.revokeObjectURL(url);
  objectUrls.delete(url);
}

function readSettings() {
  const data = new FormData(form);
  return {
    purpose: String(data.get('purpose') || '').trim(),
    expiry: String(data.get('expiry') || ''),
    signature: String(data.get('signature') || '').trim(),
    opacity: Number(data.get('opacity')),
    density: Number(data.get('density')),
    fontSize: Number(data.get('fontSize')),
    angle: Number(data.get('angle')),
    font: String(data.get('font')),
    color: String(data.get('color')),
    outline: $('outline').checked,
    offsetX: Number(data.get('offsetX')),
    offsetY: Number(data.get('offsetY')),
    jitter: Number(data.get('jitter')),
    border: $('border').checked,
    borderSize: Number(data.get('borderSize')),
    seam: $('seam').checked,
  };
}

function syncControls() {
  for (const [id, unit] of [
    ['opacity', '%'], ['density', ' / 10'], ['font-size', '%'], ['angle', '°'],
    ['offset-x', ' px'], ['offset-y', ' px'], ['jitter', ' px'], ['border-size', '%'],
  ]) $(id + '-value').textContent = $(id).value + unit;
  $('color-value').textContent = $('color').value.toUpperCase();
  $('border-settings').hidden = !$('border').checked;
  $('quality-control').hidden = $('format').value !== 'jpeg';
  $('quality').disabled = $('format').value !== 'jpeg';
  $('expiry-warning').hidden = !$('expiry').value || $('expiry').value >= localDate(new Date());
  $('download').disabled = busy || loading || !source || !$('purpose').value.trim();
}

function checkOutput(layout) {
  if (layout.width > 16384 || layout.height > 16384 || layout.width * layout.height > 40_000_000) {
    throw new Error('当前尺寸超出安全绘图范围，请缩小照片或降低白边宽度。');
  }
}

function updatePreview() {
  pendingFrame = 0;
  syncControls();
  if (!source) return;
  try {
    const settings = readSettings();
    const layout = getLayout(source, settings);
    checkOutput(layout);
    const scale = Math.min(1, 1600 / Math.max(layout.width, layout.height), Math.sqrt(2_500_000 / (layout.width * layout.height)));
    const display = { ...settings, purpose: settings.purpose || '请填写用途声明' };
    render(preview, source, display, seed, { scale, compare: comparing });
    $('output-size').textContent = '导出 ' + layout.width + ' × ' + layout.height + ' px' + (scale < 1 ? ' · 预览已缩放' : '');
  } catch (error) {
    $('download').disabled = true;
    notify(error.message, 'error');
  }
}

function schedulePreview() {
  syncControls();
  if (!pendingFrame) pendingFrame = requestAnimationFrame(updatePreview);
}

function closeSource(image) {
  if (image && typeof image.close === 'function') image.close();
  if (image instanceof HTMLCanvasElement) { image.width = 1; image.height = 1; }
  if (image instanceof HTMLImageElement) image.removeAttribute('src');
}

function showSource(image, name, isDemo) {
  closeSource(source);
  source = image;
  sourceName = name;
  demo = isDemo;
  seed = randomSeed();
  comparing = false;
  loading = false;
  $('compare').textContent = '按住对比';
  $('empty-state').hidden = true;
  preview.hidden = false;
  $('clear-image').hidden = false;
  $('preview-toolbar').hidden = false;
  $('demo-badge').hidden = !isDemo;
  $('drop-zone').classList.add('has-image');
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  $('image-info').textContent = name + ' · ' + width + ' × ' + height + ' px';
  updatePreview();
}

function clearImage(silent = false) {
  if (busy) return;
  loadVersion++;
  loading = false;
  closeSource(source);
  source = null;
  sourceName = '';
  demo = false;
  comparing = false;
  $('compare').textContent = '按住对比';
  preview.width = 1;
  preview.height = 1;
  preview.hidden = true;
  input.value = '';
  $('empty-state').hidden = false;
  $('clear-image').hidden = true;
  $('preview-toolbar').hidden = true;
  $('demo-badge').hidden = true;
  $('drop-zone').classList.remove('has-image');
  $('image-info').textContent = '一张照片，一份明确的用途声明';
  syncControls();
  if (!silent) notify('照片已从当前页面内存中清除。');
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Use the browser's image decoder as a compatibility fallback. */ }
  }
  const url = URL.createObjectURL(file);
  objectUrls.add(url);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('无法读取照片，请确认格式受支持且文件没有损坏。'));
      image.src = url;
    });
    return image;
  } finally {
    revokeUrl(url);
  }
}

async function loadFile(file) {
  if (busy || !file) return;
  if (!allowedTypes.has(file.type)) {
    notify('请选择 JPG、PNG、WebP 或 AVIF 静态照片。HEIC、GIF 和 SVG 不受支持。', 'error');
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    notify('文件超过 30 MB，请先在本地缩小照片。', 'error');
    return;
  }
  const version = ++loadVersion;
  loading = true;
  $('download').disabled = true;
  $('image-info').textContent = '正在本地读取照片…';
  let image;
  try {
    image = await decodeImage(file);
    if (version !== loadVersion) { closeSource(image); return; }
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height || width > 14000 || height > 14000 || width * height > 24_000_000) {
      closeSource(image);
      image = null;
      throw new Error('照片最多支持 2400 万像素、单边 14000 px，请先在本地缩小尺寸。');
    }
    checkOutput(getLayout(image, readSettings()));
    showSource(image, file.name || '粘贴的照片', false);
  } catch (error) {
    if (version !== loadVersion) { closeSource(image); return; }
    if (image && image !== source) closeSource(image);
    $('image-info').textContent = source ? sourceName : '照片读取失败，可重新选择';
    notify(error.message || '读取失败，请换一张照片。', 'error');
  } finally {
    if (version === loadVersion) { loading = false; syncControls(); }
    input.value = '';
  }
}

function chooseFile() { if (!busy) input.click(); }
for (const id of ['choose-image', 'replace-image']) $(id).addEventListener('click', chooseFile);
input.addEventListener('change', () => loadFile(input.files?.[0]));
$('clear-image').addEventListener('click', () => clearImage());
$('load-demo').addEventListener('click', () => {
  if (busy) return;
  loadVersion++;
  showSource(createDemo(), '合成示例证件', true);
});

form.addEventListener('input', (event) => {
  if (event.target.matches('#opacity, #density, #font-size, #angle')) {
    for (const button of document.querySelectorAll('[data-style]')) {
      button.classList.remove('selected');
      button.setAttribute('aria-pressed', 'false');
    }
  }
  schedulePreview();
});
form.addEventListener('change', schedulePreview);
for (const button of document.querySelectorAll('[data-purpose]')) button.addEventListener('click', () => {
  $('purpose').value = button.dataset.purpose;
  schedulePreview();
});
for (const button of document.querySelectorAll('[data-style]')) button.addEventListener('click', () => {
  const preset = stylePresets[button.dataset.style];
  $('opacity').value = preset.opacity;
  $('density').value = preset.density;
  $('font-size').value = preset.fontSize;
  $('angle').value = preset.angle;
  for (const item of document.querySelectorAll('[data-style]')) {
    item.classList.toggle('selected', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  }
  schedulePreview();
});
$('reset-settings').addEventListener('click', () => {
  form.reset();
  defaultExpiry();
  seed = randomSeed();
  document.querySelector('[data-style="balanced"]').click();
  schedulePreview();
  notify('水印参数已恢复默认。');
});
$('reseed').addEventListener('click', () => {
  seed = randomSeed();
  schedulePreview();
  notify('已生成新的随机排列，预览与导出使用同一排列。');
});

function compare(value) {
  if (!source || busy || comparing === value) return;
  comparing = value;
  $('compare').textContent = value ? '松开返回' : '按住对比';
  schedulePreview();
}
$('compare').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  $('compare').setPointerCapture(event.pointerId);
  compare(true);
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('compare').addEventListener(event, () => compare(false));
$('compare').addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); compare(true); }
});
$('compare').addEventListener('keyup', () => compare(false));
$('compare').addEventListener('blur', () => compare(false));
window.addEventListener('blur', () => compare(false));

const zone = $('drop-zone');
zone.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
zone.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = event.dataTransfer?.files;
  if (files?.length > 1) notify('一次处理一张照片，本次使用第一个文件。');
  loadFile(files?.[0]);
});
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
});
document.addEventListener('paste', (event) => {
  if (event.target.matches('input,textarea') || event.target.isContentEditable || busy) return;
  const item = Array.from(event.clipboardData?.items || []).find((candidate) => candidate.kind === 'file' && allowedTypes.has(candidate.type));
  if (item) { event.preventDefault(); loadFile(item.getAsFile()); }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!source || busy || loading) return;
  const settings = readSettings();
  if (!settings.purpose) { notify('请先填写用途声明。', 'error'); $('purpose').focus(); return; }
  if ($('format').value === 'jpeg' && !$('quality').checkValidity()) { $('quality').reportValidity(); return; }
  comparing = false;
  const format = $('format').value;
  const quality = Math.max(0.7, Math.min(1, Number($('quality').value || 95) / 100));
  const name = sourceName;
  const isDemo = demo;
  const exportSeed = seed;
  const exportSource = source;
  const exportVersion = loadVersion;
  const canvas = document.createElement('canvas');
  busy = true;
  $('download').disabled = true;
  const buttonLabel = $('download').querySelector('span');
  buttonLabel.textContent = '正在本地生成…';
  try {
    checkOutput(getLayout(source, settings));
    // Let the busy label paint before the full-resolution synchronous draw.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (exportVersion !== loadVersion) return;
    render(canvas, exportSource, settings, exportSeed);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('无法生成文件，请尝试 JPG 或缩小照片。')), 'image/' + format, quality);
    });
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const link = document.createElement('a');
    const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80) || '证件照片';
    link.download = stem + '-水印.' + (blob.type === 'image/jpeg' ? 'jpg' : 'png');
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => revokeUrl(url), 15000);
    notify((isDemo ? '合成示例' : '水印照片') + '已在本地生成，请确认下载结果。', 'success');
  } catch (error) {
    notify(error.message || '生成失败，请缩小照片后重试。', 'error');
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    busy = false;
    buttonLabel.textContent = '下载加水印照片';
    syncControls();
    schedulePreview();
  }
});

// Navigating away releases references, including when the browser uses its back-forward cache.
window.addEventListener('pagehide', () => {
  busy = false;
  clearImage(true);
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
});
defaultExpiry();
syncControls();
