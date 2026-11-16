// Decodes the PNG that `adb exec-out screencap -p` produces (8-bit, non-interlaced, RGB or RGBA) with
// node:zlib only, and offers the few pixel measurements the baseline needs. Screenshots are the one
// source of truth for where a native preview really is on screen.
import { inflateSync } from 'node:zlib';

export function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[out + x - channels] : 0;
      const up = y > 0 ? pixels[out + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[out + x - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = (left + up) >> 1;
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[out + x] = (raw[line + x] + predictor) & 0xff;
    }
  }

  const at = (x, y) => {
    const index = y * stride + x * channels;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  };
  return { width, height, at };
}

const near = (a, b, tolerance) =>
  Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance;

/**
 * Bounding box of the pixels matching `matches(rgb)`, or `null` when none match. Rows and columns
 * are sampled every `step` pixels and the edges are then refined to the exact pixel.
 */
export function boundingBox(image, matches, step = 4) {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      if (matches(image.at(x, y))) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < 0) {
    return null;
  }

  const rowHas = (y, from, to) => {
    for (let x = from; x <= to; x++) {
      if (matches(image.at(x, y))) {
        return true;
      }
    }
    return false;
  };
  const columnHas = (x, from, to) => {
    for (let y = from; y <= to; y++) {
      if (matches(image.at(x, y))) {
        return true;
      }
    }
    return false;
  };
  while (top > 0 && rowHas(top - 1, left, right)) top--;
  while (bottom < image.height - 1 && rowHas(bottom + 1, left, right)) bottom++;
  while (left > 0 && columnHas(left - 1, top, bottom)) left--;
  while (right < image.width - 1 && columnHas(right + 1, top, bottom)) right++;

  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

export const isColor = (rgb, tolerance = 12) => (pixel) => near(pixel, rgb, tolerance);
export const isNotColor = (rgb, tolerance = 12) => (pixel) => !near(pixel, rgb, tolerance);

/**
 * Describes how varied a region is: the number of distinct colours (quantised to 4 bits a channel)
 * among a grid of samples. A live camera image has many; a flat background has one or two.
 */
export function colorVariety(image, box, samples = 24) {
  const seen = new Set();
  for (let row = 0; row < samples; row++) {
    for (let column = 0; column < samples; column++) {
      const x = Math.min(image.width - 1, Math.round(box.left + ((column + 0.5) * box.width) / samples));
      const y = Math.min(image.height - 1, Math.round(box.top + ((row + 0.5) * box.height) / samples));
      const [r, g, b] = image.at(x, y);
      seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return seen.size;
}
