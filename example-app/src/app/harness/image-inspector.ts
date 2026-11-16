/**
 * Reads image facts from the encoded bytes, never from an `<img>` element: a WebView applies the
 * EXIF orientation before reporting `naturalWidth`/`naturalHeight`, which hides exactly the
 * differences this harness exists to show.
 *
 * The format is detected from the bytes. The web implementation returns PNG when `quality` is
 * omitted, so JPEG-only facts (EXIF, SOF type) are reported as not applicable for other formats
 * instead of being left looking like missing data.
 */

export type ImageFormat = 'jpeg' | 'png' | 'unknown';

export interface JpegDetails {
  /** SOF marker found: 0xC0 baseline, 0xC2 progressive, etc. */
  sofMarker: number | null;
  hasExif: boolean;
  /** Raw EXIF orientation tag (1–8); `null` when there is no tag. */
  orientation: number | null;
  /** `PixelXDimension` / `PixelYDimension` from the Exif sub-IFD, when present. */
  exifPixelWidth: number | null;
  exifPixelHeight: number | null;
  make: string | null;
  model: string | null;
  dateTime: string | null;
  /** True when IFD1 carries an embedded JPEG thumbnail. */
  hasThumbnail: boolean;
}

export interface PngDetails {
  bitDepth: number;
  colorType: number;
}

export interface ImageInfo {
  format: ImageFormat;
  byteLength: number;
  /** Pixel size as encoded, before any orientation is applied. `null` when it could not be read. */
  encodedWidth: number | null;
  encodedHeight: number | null;
  /** Pixel size once the EXIF orientation is applied (same as encoded for PNG). */
  displayWidth: number | null;
  displayHeight: number | null;
  jpeg: JpegDetails | null;
  png: PngDetails | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return 'png';
  }
  return 'unknown';
}

export function mimeTypeFor(format: ImageFormat): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

export function fileExtensionFor(format: ImageFormat): string {
  switch (format) {
    case 'jpeg':
      return 'jpg';
    case 'png':
      return 'png';
    default:
      return 'bin';
  }
}

export function inspectImage(bytes: Uint8Array): ImageInfo {
  const format = detectImageFormat(bytes);
  const info: ImageInfo = {
    format,
    byteLength: bytes.length,
    encodedWidth: null,
    encodedHeight: null,
    displayWidth: null,
    displayHeight: null,
    jpeg: null,
    png: null,
  };

  if (format === 'jpeg') {
    inspectJpeg(bytes, info);
  } else if (format === 'png') {
    inspectPng(bytes, info);
  }

  return info;
}

/** Orientations 5–8 transpose the image, so the displayed size has width and height swapped. */
export function orientationSwapsAxes(orientation: number | null): boolean {
  return orientation !== null && orientation >= 5 && orientation <= 8;
}

export function describeOrientation(orientation: number | null): string {
  switch (orientation) {
    case 1:
      return '1 (upright)';
    case 2:
      return '2 (mirrored horizontally)';
    case 3:
      return '3 (rotated 180°)';
    case 4:
      return '4 (mirrored vertically)';
    case 5:
      return '5 (transposed)';
    case 6:
      return '6 (display rotated 90° clockwise)';
    case 7:
      return '7 (transversed)';
    case 8:
      return '8 (display rotated 90° counter-clockwise)';
    case null:
      return 'no orientation tag';
    default:
      return `${orientation} (not a valid EXIF orientation)`;
  }
}

function inspectPng(bytes: Uint8Array, info: ImageInfo): void {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) + depth (1) + colour (1).
  if (bytes.length < 26 || ascii(bytes, 12, 4) !== 'IHDR') {
    return;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  info.encodedWidth = view.getUint32(16);
  info.encodedHeight = view.getUint32(20);
  info.displayWidth = info.encodedWidth;
  info.displayHeight = info.encodedHeight;
  info.png = { bitDepth: bytes[24], colorType: bytes[25] };
}

function inspectJpeg(bytes: Uint8Array, info: ImageInfo): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jpeg: JpegDetails = {
    sofMarker: null,
    hasExif: false,
    orientation: null,
    exifPixelWidth: null,
    exifPixelHeight: null,
    make: null,
    model: null,
    dateTime: null,
    hasThumbnail: false,
  };
  info.jpeg = jpeg;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }
    const marker = bytes[offset + 1];
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      break;
    }

    if (marker === 0xe1 && length >= 8 && ascii(bytes, offset + 4, 6) === 'Exif\0\0') {
      jpeg.hasExif = true;
      readExif(view, offset + 10, offset + 2 + length, jpeg);
    } else if (isStartOfFrame(marker) && length >= 7) {
      jpeg.sofMarker = marker;
      info.encodedHeight = view.getUint16(offset + 5);
      info.encodedWidth = view.getUint16(offset + 7);
    }

    offset += 2 + length;
  }

  if (info.encodedWidth !== null && info.encodedHeight !== null) {
    const swap = orientationSwapsAxes(jpeg.orientation);
    info.displayWidth = swap ? info.encodedHeight : info.encodedWidth;
    info.displayHeight = swap ? info.encodedWidth : info.encodedHeight;
  }
}

function isStartOfFrame(marker: number): boolean {
  // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_THUMBNAIL_OFFSET = 0x0201;
const TAG_THUMBNAIL_LENGTH = 0x0202;

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

function readExif(view: DataView, tiffStart: number, segmentEnd: number, jpeg: JpegDetails): void {
  if (tiffStart + 8 > segmentEnd) {
    return;
  }
  const order = view.getUint16(tiffStart);
  if (order !== 0x4949 && order !== 0x4d4d) {
    return;
  }
  const little = order === 0x4949;
  if (view.getUint16(tiffStart + 2, little) !== 42) {
    return;
  }

  const entryCountAt = (ifd: number): number | null =>
    ifd >= tiffStart && ifd + 2 <= segmentEnd ? view.getUint16(ifd, little) : null;

  const readIfd = (ifd: number, visit: (tag: number, type: number, count: number, valueAt: number) => void): number => {
    const count = entryCountAt(ifd);
    if (count === null) {
      return 0;
    }
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > segmentEnd) {
        return 0;
      }
      visit(
        view.getUint16(entry, little),
        view.getUint16(entry + 2, little),
        view.getUint32(entry + 4, little),
        entry + 8,
      );
    }
    const next = ifd + 2 + count * 12;
    return next + 4 <= segmentEnd ? view.getUint32(next, little) : 0;
  };

  const readNumber = (type: number, valueAt: number): number | null => {
    if (type === TYPE_SHORT) {
      return view.getUint16(valueAt, little);
    }
    if (type === TYPE_LONG) {
      return view.getUint32(valueAt, little);
    }
    return null;
  };

  const readText = (type: number, count: number, valueAt: number): string | null => {
    if (type !== TYPE_ASCII || count === 0) {
      return null;
    }
    const start = count <= 4 ? valueAt : tiffStart + view.getUint32(valueAt, little);
    if (start < tiffStart || start + count > segmentEnd) {
      return null;
    }
    let text = '';
    for (let index = 0; index < count; index++) {
      const code = view.getUint8(start + index);
      if (code === 0) {
        break;
      }
      text += String.fromCharCode(code);
    }
    return text.trim();
  };

  let exifIfdOffset = 0;
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, little);
  const ifd1Offset = readIfd(ifd0, (tag, type, count, valueAt) => {
    switch (tag) {
      case TAG_ORIENTATION:
        jpeg.orientation = readNumber(type, valueAt);
        break;
      case TAG_MAKE:
        jpeg.make = readText(type, count, valueAt);
        break;
      case TAG_MODEL:
        jpeg.model = readText(type, count, valueAt);
        break;
      case TAG_DATE_TIME:
        jpeg.dateTime = readText(type, count, valueAt);
        break;
      case TAG_EXIF_IFD:
        exifIfdOffset = readNumber(type, valueAt) ?? 0;
        break;
      default:
        break;
    }
  });

  if (exifIfdOffset > 0) {
    readIfd(tiffStart + exifIfdOffset, (tag, type, _count, valueAt) => {
      if (tag === TAG_PIXEL_X) {
        jpeg.exifPixelWidth = readNumber(type, valueAt);
      } else if (tag === TAG_PIXEL_Y) {
        jpeg.exifPixelHeight = readNumber(type, valueAt);
      }
    });
  }

  if (ifd1Offset > 0) {
    let thumbnailOffset = 0;
    let thumbnailLength = 0;
    readIfd(tiffStart + ifd1Offset, (tag, type, _count, valueAt) => {
      if (tag === TAG_THUMBNAIL_OFFSET) {
        thumbnailOffset = readNumber(type, valueAt) ?? 0;
      } else if (tag === TAG_THUMBNAIL_LENGTH) {
        thumbnailLength = readNumber(type, valueAt) ?? 0;
      }
    });
    jpeg.hasThumbnail = thumbnailOffset > 0 && thumbnailLength > 0;
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  for (let index = start; index < start + length && index < bytes.length; index++) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

const BASE64_CHUNK = 0x8000;

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
  }
  return btoa(binary);
}
