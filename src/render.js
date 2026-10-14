import { qrcodegen } from './vendor/qrcodegen.js';
import { footerLayout, drawProofPlaceholder, IMAGE_MARKER_SIZE } from './proof.js';
// Drawing remains local. Signing is requested separately by the export flow.
const SITE_URL = 'https://zjsy.zhtianqi.cn';
const FONTS = {
  sans: '"PingFang SC","Microsoft YaHei",sans-serif',
  serif: '"Songti SC","SimSun",serif',
  mono: '"SFMono-Regular",Consolas,"Microsoft YaHei",monospace',
};

export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let n = Math.imul(value ^ (value >>> 15), value | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function getLayout(image, settings) {
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  const sourceScale = settings.exportMax ? Math.min(1, settings.exportMax / Math.max(originalWidth, originalHeight)) : 1;
  const width = Math.max(1, Math.round(originalWidth * sourceScale));
  const height = Math.max(1, Math.round(originalHeight * sourceScale));
  const rawSide = settings.border ? Math.round(Math.min(width, height) * settings.borderSize / 100) : 0;
  const side = settings.border && settings.verification ? Math.max(IMAGE_MARKER_SIZE, rawSide) : rawSide;
  const top = settings.border ? side + Math.max(210, Math.round(Math.min(width, height) * 0.19)) : 0;
  const proof = settings.border && settings.verification;
  const fullWidth = settings.border ? Math.max(proof ? 640 : 360, width + side * 2) : width;
  const bodyHeight = height + side + top;
  const fullHeight = proof ? footerLayout(fullWidth, bodyHeight, settings).height : bodyHeight;
  return { width: fullWidth, height: fullHeight, bodyHeight, imageX: Math.round((fullWidth - width) / 2), imageY: top, imageWidth: width, imageHeight: height, side, top, sourceScale };
}

function wrapText(context, text, maxWidth) {
  const result = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        result.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

function contentLines(context, settings, maxWidth) {
  const lines = wrapText(context, settings.purpose, maxWidth);
  if (settings.expiry) lines.push(...wrapText(context, '有效期至 ' + settings.expiry, maxWidth));
  if (settings.signature.trim()) lines.push(...wrapText(context, '签名：' + settings.signature.trim(), maxWidth));
  return lines;
}

function paintText(context, lines, fontSize, settings) {
  const lineHeight = fontSize * 1.38;
  const start = -(lines.length - 1) * lineHeight / 2;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = settings.color;
  context.lineJoin = 'round';
  if (settings.outline) {
    context.strokeStyle = '#ffffff';
    context.lineWidth = Math.max(0.6, fontSize * 0.045);
  }
  lines.forEach((line, index) => {
    const y = start + index * lineHeight;
    if (settings.outline) context.strokeText(line, 0, y);
    context.fillText(line, 0, y);
  });
}

function drawTiles(context, layout, settings, seed) {
  const random = randomGenerator(seed);
  const fontSize = Math.max(6, Math.min(layout.imageWidth, layout.imageHeight) * settings.fontSize / 100);
  context.save();
  // Clip before transforming: ordinary watermarks remain within the original image.
  context.beginPath();
  context.rect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight);
  context.clip();
  context.translate(layout.imageX + layout.imageWidth / 2 + settings.offsetX, layout.imageY + layout.imageHeight / 2 + settings.offsetY);
  context.rotate(settings.angle * Math.PI / 180);
  context.font = '600 ' + fontSize + 'px ' + FONTS[settings.font];
  const lines = contentLines(context, settings, Math.min(layout.imageWidth, layout.imageHeight) * 0.7);
  const textWidth = Math.max(...lines.map((line) => context.measureText(line).width), fontSize);
  const gap = (11 - settings.density) * fontSize;
  const stepX = textWidth + gap * 1.35;
  const stepY = lines.length * fontSize * 1.38 + gap * 1.3;
  const radius = Math.hypot(layout.imageWidth, layout.imageHeight) / 2 + Math.abs(settings.offsetX) + Math.abs(settings.offsetY) + stepX;
  const columns = Math.ceil(radius / stepX);
  const rows = Math.ceil(radius / stepY);
  for (let row = -rows; row <= rows; row++) {
    for (let col = -columns; col <= columns; col++) {
      context.save();
      const x = col * stepX + (Math.abs(row) % 2) * stepX / 2;
      const y = row * stepY;
      // Consume the same random sequence even when jitter is disabled.
      const dx = (random() * 2 - 1) * settings.jitter;
      const dy = (random() * 2 - 1) * settings.jitter;
      const rotation = (random() * 2 - 1) * (settings.jitter ? 2 : 0) * Math.PI / 180;
      const alpha = settings.opacity / 100 * (1 + (random() * 2 - 1) * (settings.jitter ? 0.1 : 0));
      context.translate(x + dx, y + dy);
      context.rotate(rotation);
      context.globalAlpha = alpha;
      paintText(context, lines, fontSize, settings);
      context.restore();
    }
  }
  context.restore();
}

function drawBrandLogo(context, x, y, size) {
  const logo = document.querySelector('.brand img');
  if (logo?.complete && logo.naturalWidth) context.drawImage(logo, x, y, size, size);
  else {
    context.fillStyle = '#5346d5';
    context.fillRect(x, y, size, size);
    context.fillStyle = '#fff';
    context.font = '700 ' + Math.max(8, size * 0.62) + 'px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Z', x + size / 2, y + size / 2);
  }
}

function drawSiteCode(context, layout) {
  const qr = qrcodegen.QrCode.encodeText(SITE_URL, qrcodegen.QrCode.Ecc.MEDIUM);
  const side = layout.side;
  const maxSize = Math.min(120, (layout.top - side * 2) * 0.9, layout.width * 0.32);
  const moduleSize = Math.max(1, Math.min(3, Math.floor(maxSize / (qr.size + 8))));
  const size = (qr.size + 8) * moduleSize;
  const x = side;
  const y = side;
  context.fillStyle = '#fff';
  context.fillRect(x, y, size, size);
  context.fillStyle = '#171923';
  for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) {
    if (qr.getModule(col, row)) context.fillRect(x + (col + 4) * moduleSize, y + (row + 4) * moduleSize, moduleSize, moduleSize);
  }
  return { x, y, size, right: x + size, bottom: y + size };
}

function drawBorderBrand(context, layout) {
  const qr = drawSiteCode(context, layout);
  const gap = Math.max(12, Math.round(layout.side * 0.32));
  const logoSize = Math.min(44, Math.max(30, qr.size * 0.42));
  const logoX = qr.right + gap;
  const logoY = qr.y + (qr.size - logoSize) / 2;
  drawBrandLogo(context, logoX, logoY, logoSize);
  const textX = logoX + logoSize + 10;
  const textWidth = Math.min(210, Math.max(60, layout.width - textX - layout.side));
  context.save();
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillStyle = '#333447';
  context.font = '700 13px ' + FONTS.sans;
  context.fillText('证件水印', textX, logoY + logoSize * 0.32, textWidth);
  context.fillStyle = '#686b7c';
  context.font = '500 10px ' + FONTS.sans;
  context.fillText(SITE_URL, textX, logoY + logoSize * 0.75, textWidth);
  context.restore();
  return { bottom: qr.bottom };
}

function drawBorderHeader(context, layout, settings) {
  const brand = drawBorderBrand(context, layout);
  const maxWidth = Math.max(48, layout.width - layout.side * 2);
  const textTop = brand.bottom + 12;
  const textBottom = layout.top - layout.side * 0.3;
  const availableHeight = Math.max(18, textBottom - textTop);
  let size = Math.max(7, Math.min(30, Math.min(layout.imageWidth, layout.imageHeight) * 0.036));
  let lines;
  let metaLines;
  const meta = [settings.expiry ? '有效期至 ' + settings.expiry : '', settings.signature.trim() ? '签名：' + settings.signature.trim() : ''].filter(Boolean).join('  ·  ');
  for (let attempt = 0; attempt < 60; attempt++) {
    context.font = '700 ' + size + 'px ' + FONTS.sans;
    lines = wrapText(context, settings.purpose, maxWidth);
    context.font = '500 ' + (size * 0.7) + 'px ' + FONTS.sans;
    metaLines = meta ? wrapText(context, meta, maxWidth) : [];
    const totalHeight = lines.length * size * 1.32 + metaLines.length * size + size * 0.6;
    if (totalHeight <= availableHeight || size <= 4) break;
    size *= 0.94;
  }
  const totalHeight = lines.length * size * 1.32 + metaLines.length * size;
  let y = textTop + Math.max(size * 0.35, (availableHeight - totalHeight) / 2) + size * 0.5;
  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#252735';
  context.font = '700 ' + size + 'px ' + FONTS.sans;
  for (const line of lines) {
    context.fillText(line, layout.width / 2, y, maxWidth);
    y += size * 1.32;
  }
  context.fillStyle = '#626678';
  context.font = '500 ' + (size * 0.7) + 'px ' + FONTS.sans;
  for (const line of metaLines) {
    context.fillText(line, layout.width / 2, y, maxWidth);
    y += size;
  }
  context.restore();
}

function drawFinderMarker(context, x, y) {
  context.fillStyle = '#fff';
  context.fillRect(x, y, IMAGE_MARKER_SIZE, IMAGE_MARKER_SIZE);
  context.fillStyle = '#171923';
  for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const black = row === 0 || row === 6 || col === 0 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4);
    if (black) context.fillRect(x + (col + 1) * 3, y + (row + 1) * 3, 3, 3);
  }
}

function drawImageMarkers(context, layout) {
  const x = layout.imageX;
  const y = layout.imageY;
  const right = x + layout.imageWidth;
  const bottom = y + layout.imageHeight;
  drawFinderMarker(context, x - IMAGE_MARKER_SIZE, y);
  drawFinderMarker(context, right, y);
  drawFinderMarker(context, x - IMAGE_MARKER_SIZE, bottom - IMAGE_MARKER_SIZE);
  drawFinderMarker(context, right, bottom - IMAGE_MARKER_SIZE);
}

function drawSeams(context, layout, settings, seed) {
  const random = randomGenerator(seed ^ 0xAC51);
  const fontSize = Math.max(5, Math.min(layout.imageWidth, layout.imageHeight) * settings.fontSize / 100 * 0.8);
  context.save();
  context.font = '600 ' + fontSize + 'px ' + FONTS[settings.font];
  const lines = contentLines(context, settings, Math.min(layout.imageWidth, layout.imageHeight) * 0.6);
  const anchors = [
    [layout.imageX + layout.imageWidth * 0.27, layout.imageY, -12],
    [layout.imageX + layout.imageWidth * 0.73, layout.imageY, 12],
    [layout.imageX + layout.imageWidth * 0.35, layout.imageY + layout.imageHeight, -12],
    [layout.imageX + layout.imageWidth * 0.75, layout.imageY + layout.imageHeight, 12],
    [layout.imageX, layout.imageY + layout.imageHeight * 0.5, -90],
    [layout.imageX + layout.imageWidth, layout.imageY + layout.imageHeight * 0.5, 90],
  ];
  for (const [x, y, angle] of anchors) {
    context.save();
    // Keep each anchor on the boundary so jitter cannot detach a seam watermark.
    context.translate(x, y);
    context.rotate((angle + (settings.jitter ? (random() * 2 - 1) * 2 : 0)) * Math.PI / 180);
    context.globalAlpha = Math.min(0.8, Math.max(0.3, settings.opacity / 100 + 0.12));
    paintText(context, lines, fontSize, settings);
    context.restore();
  }
  context.restore();
}

export function render(canvas, image, settings, seed, { scale = 1, compare = false } = {}) {
  const layout = getLayout(image, settings);
  canvas.width = Math.max(1, Math.round(layout.width * scale));
  canvas.height = Math.max(1, Math.round(layout.height * scale));
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!context) throw new Error('浏览器未能创建绘图画布，请更换浏览器。');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, layout.width, layout.height);
  context.drawImage(image, layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight);
  if (!compare) {
    const pixels = { ...settings, offsetX: settings.offsetX * layout.sourceScale, offsetY: settings.offsetY * layout.sourceScale, jitter: settings.jitter * layout.sourceScale };
    drawTiles(context, layout, pixels, seed);
    if (settings.border) {
      drawBorderHeader(context, layout, settings);
      if (settings.seam) drawSeams(context, layout, settings, seed);
      if (settings.verification) {
        drawProofPlaceholder(context, layout, settings);
        drawImageMarkers(context, layout);
      }
    }
  }
  return layout;
}

export function createDemo() {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 680;
  const context = canvas.getContext('2d');
  context.fillStyle = '#edf3fa';
  context.fillRect(0, 0, 1080, 680);
  const gradient = context.createLinearGradient(0, 0, 1080, 680);
  gradient.addColorStop(0, '#f8fafc');
  gradient.addColorStop(1, '#dfe8f5');
  context.fillStyle = gradient;
  context.fillRect(28, 28, 1024, 624);
  context.strokeStyle = '#c8d8eb';
  context.lineWidth = 2;
  for (let i = -400; i < 1500; i += 45) {
    context.beginPath();
    context.moveTo(i, 680);
    context.lineTo(i + 420, 0);
    context.stroke();
  }
  context.fillStyle = '#314f73';
  context.font = '700 38px ' + FONTS.sans;
  context.fillText('示例证件  /  DEMO ONLY', 67, 104);
  context.fillStyle = '#c3d5e9';
  context.fillRect(745, 166, 260, 328);
  context.fillStyle = '#94b1d0';
  context.beginPath();
  context.arc(875, 268, 61, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(875, 457, 110, 125, 0, Math.PI, 0);
  context.lineTo(985, 494);
  context.lineTo(765, 494);
  context.fill();
  context.font = '500 24px ' + FONTS.sans;
  context.fillStyle = '#7691ae';
  const fields = [['姓名', '示例人物'], ['用途', '仅作界面演示'], ['编号', 'DEMO 0000 0000 0000'], ['地址', '这不是一张真实证件']];
  fields.forEach(([label, value], index) => {
    context.fillStyle = '#7691ae';
    context.fillText(label, 68, 206 + index * 82);
    context.fillStyle = '#456585';
    context.fillText(value, 168, 206 + index * 82);
  });
  context.font = '500 21px ' + FONTS.sans;
  context.fillStyle = '#88a0ba';
  context.fillText('本示例由浏览器绘制 · 不含真实个人信息', 67, 603);
  return canvas;
}
