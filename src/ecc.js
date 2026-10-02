// Reed–Solomon RS(255,191), GF(256), primitive polynomial 0x11d.
// Sixty-four parity symbols correct up to 32 erroneous bytes per copy.
const PARITY = 64;
const DATA = 191;
const exp = new Uint8Array(512);
const log = new Uint8Array(256);
let value = 1;
for (let i = 0; i < 255; i++) {
  exp[i] = value;
  log[value] = i;
  value <<= 1;
  if (value & 256) value ^= 0x11d;
}
for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
const multiply = (a, b) => a && b ? exp[log[a] + log[b]] : 0;
const divide = (a, b) => { if (!b) throw new Error('Invalid correction divisor'); return a ? exp[(log[a] - log[b] + 255) % 255] : 0; };
function evaluate(poly, x) {
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) y = multiply(y, x) ^ poly[i];
  return y;
}
function syndromes(word) {
  return Array.from({ length: PARITY }, (_, i) => evaluate(word, exp[i]));
}
let generator = [1];
for (let i = 0; i < PARITY; i++) {
  const next = new Array(generator.length + 1).fill(0);
  for (let j = 0; j < generator.length; j++) {
    next[j] ^= generator[j];
    next[j + 1] ^= multiply(generator[j], exp[i]);
  }
  generator = next;
}

export function encode(payload) {
  if (payload.length > DATA - 6) throw new Error('Verification carrier payload is too large');
  const data = new Uint8Array(DATA);
  const view = new DataView(data.buffer);
  view.setUint16(0, payload.length);
  data.set(payload, 2);
  view.setUint32(DATA - 4, crc32(data.subarray(0, DATA - 4)));
  const output = new Uint8Array(255);
  output.set(data);
  for (let i = 0; i < DATA; i++) {
    const coefficient = output[i];
    for (let j = 1; j <= PARITY; j++) output[i + j] ^= multiply(generator[j], coefficient);
  }
  output.set(data);
  return output;
}

export function decode(input) {
  if (input.length !== 255) throw new Error('Invalid correction block');
  const output = new Uint8Array(input);
  const syndrome = syndromes(output);
  if (syndrome.some(Boolean)) {
    let locator = [1];
    let previous = [1];
    let length = 0;
    let distance = 1;
    let discrepancyPrevious = 1;
    for (let n = 0; n < PARITY; n++) {
      let discrepancy = syndrome[n];
      for (let i = 1; i <= length; i++) discrepancy ^= multiply(locator[i] || 0, syndrome[n - i]);
      if (!discrepancy) { distance++; continue; }
      const old = [...locator];
      const factor = divide(discrepancy, discrepancyPrevious);
      while (locator.length < previous.length + distance) locator.push(0);
      for (let i = 0; i < previous.length; i++) locator[i + distance] ^= multiply(factor, previous[i]);
      if (2 * length <= n) {
        length = n + 1 - length;
        previous = old;
        discrepancyPrevious = discrepancy;
        distance = 1;
      } else distance++;
    }
    if (!length || length > PARITY / 2) throw new Error('Carrier damage exceeds correction capacity');
    const positions = [];
    for (let p = 0; p < 255; p++) {
      const x = exp[(255 - (254 - p)) % 255];
      let y = 0;
      for (let i = locator.length - 1; i >= 0; i--) y = multiply(y, x) ^ locator[i];
      if (y === 0) positions.push(p);
    }
    if (positions.length !== length) throw new Error('Carrier errors cannot be located');
    const matrix = Array.from({ length }, (_, row) => [
      ...positions.map((p) => exp[((254 - p) * row) % 255]),
      syndrome[row],
    ]);
    for (let column = 0; column < length; column++) {
      let pivot = column;
      while (pivot < length && matrix[pivot][column] === 0) pivot++;
      if (pivot === length) throw new Error('Carrier errors cannot be solved');
      [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
      const inverse = divide(1, matrix[column][column]);
      for (let j = column; j <= length; j++) matrix[column][j] = multiply(matrix[column][j], inverse);
      for (let row = 0; row < length; row++) {
        if (row === column) continue;
        const factor = matrix[row][column];
        for (let j = column; j <= length; j++) matrix[row][j] ^= multiply(factor, matrix[column][j]);
      }
    }
    positions.forEach((p, i) => { output[p] ^= matrix[i][length]; });
    if (syndromes(output).some(Boolean)) throw new Error('Carrier correction failed');
  }
  const view = new DataView(output.buffer);
  const size = view.getUint16(0);
  if (size > DATA - 6 || view.getUint32(DATA - 4) !== crc32(output.subarray(0, DATA - 4))) throw new Error('Invalid carrier checksum');
  return output.slice(2, 2 + size);
}

function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}
