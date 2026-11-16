// Reads image facts from encoded bytes on the host. This is deliberately a second, independent
// implementation of the in-app inspector (src/app/harness/image-inspector.ts): every run compares
// the two, so a mistake in either reader shows up as a disagreement instead of as a wrong baseline.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  return 'unknown';
}

export function extensionFor(format) {
  return format === 'jpeg' ? 'jpg' : format === 'png' ? 'png' : 'bin';
}

/**
 * @returns {{format: string, byteLength: number, encodedWidth: number|null, encodedHeight: number|null,
 *   displayWidth: number|null, displayHeight: number|null, hasExif: boolean|null,
 *   orientation: number|null, hasThumbnail: boolean|null}}
 * `hasExif`, `orientation` and `hasThumbnail` are `null` for formats where they do not apply.
 */
export function inspectImage(bytes) {
  const format = detectFormat(bytes);
  const info = {
    format,
    byteLength: bytes.length,
    encodedWidth: null,
    encodedHeight: null,
    displayWidth: null,
    displayHeight: null,
    hasExif: null,
    orientation: null,
    hasThumbnail: null,
  };

  if (format === 'png') {
    if (bytes.length >= 24 && bytes.toString('latin1', 12, 16) === 'IHDR') {
      info.encodedWidth = bytes.readUInt32BE(16);
      info.encodedHeight = bytes.readUInt32BE(20);
      info.displayWidth = info.encodedWidth;
      info.displayHeight = info.encodedHeight;
    }
    return info;
  }
  if (format !== 'jpeg') {
    return info;
  }

  info.hasExif = false;
  info.hasThumbnail = false;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      break;
    }

    if (marker === 0xe1 && bytes.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
      info.hasExif = true;
      readExif(bytes, offset + 10, offset + 2 + length, info);
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      info.encodedHeight = bytes.readUInt16BE(offset + 5);
      info.encodedWidth = bytes.readUInt16BE(offset + 7);
    }
    offset += 2 + length;
  }

  if (info.encodedWidth !== null) {
    const swap = info.orientation !== null && info.orientation >= 5 && info.orientation <= 8;
    info.displayWidth = swap ? info.encodedHeight : info.encodedWidth;
    info.displayHeight = swap ? info.encodedWidth : info.encodedHeight;
  }
  return info;
}

function readExif(bytes, tiff, end, info) {
  if (tiff + 8 > end) {
    return;
  }
  const order = bytes.toString('latin1', tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') {
    return;
  }
  const little = order === 'II';
  const u16 = (at) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const value = (type, at) => (type === 3 ? u16(at) : type === 4 ? u32(at) : null);

  const walk = (ifd, visit) => {
    if (ifd < tiff || ifd + 2 > end) {
      return 0;
    }
    const count = u16(ifd);
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > end) {
        return 0;
      }
      visit(u16(entry), u16(entry + 2), entry + 8);
    }
    const next = ifd + 2 + count * 12;
    return next + 4 <= end ? u32(next) : 0;
  };

  const ifd1 = walk(tiff + u32(tiff + 4), (tag, type, at) => {
    if (tag === 0x0112) {
      info.orientation = value(type, at);
    }
  });
  if (ifd1 > 0) {
    let thumbnailOffset = 0;
    let thumbnailLength = 0;
    walk(tiff + ifd1, (tag, type, at) => {
      if (tag === 0x0201) {
        thumbnailOffset = value(type, at) ?? 0;
      } else if (tag === 0x0202) {
        thumbnailLength = value(type, at) ?? 0;
      }
    });
    info.hasThumbnail = thumbnailOffset > 0 && thumbnailLength > 0;
  }
}

/**
 * Duration and track kinds of an MP4 file, read from its `moov` box. Enough to tell whether a
 * recording is a playable container with a video track, and whether it has an audio track.
 */
export function inspectMp4(bytes) {
  const info = { isMp4: false, durationSeconds: null, tracks: [] };
  const boxes = (start, end, visit) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      let header = 8;
      if (size === 1 && offset + 16 <= end) {
        size = Number(bytes.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) {
        return;
      }
      visit(type, offset + header, offset + size);
      offset += size;
    }
  };

  boxes(0, bytes.length, (type, start, end) => {
    if (type === 'ftyp') {
      info.isMp4 = true;
    } else if (type === 'moov') {
      boxes(start, end, (inner, innerStart, innerEnd) => {
        if (inner === 'mvhd') {
          const version = bytes[innerStart];
          const timescale = bytes.readUInt32BE(innerStart + (version === 1 ? 20 : 12));
          const duration =
            version === 1 ? Number(bytes.readBigUInt64BE(innerStart + 24)) : bytes.readUInt32BE(innerStart + 16);
          info.durationSeconds = timescale > 0 ? duration / timescale : null;
        } else if (inner === 'trak') {
          boxes(innerStart, innerEnd, (trak, trakStart, trakEnd) => {
            if (trak === 'mdia') {
              boxes(trakStart, trakEnd, (mdia, mdiaStart) => {
                if (mdia === 'hdlr') {
                  info.tracks.push(bytes.toString('latin1', mdiaStart + 8, mdiaStart + 12));
                }
              });
            }
          });
        }
      });
    }
  });
  return info;
}
