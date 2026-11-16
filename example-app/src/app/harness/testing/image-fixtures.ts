/**
 * Builds tiny, valid-enough image files for the unit tests, so the inspector is exercised on bytes
 * whose layout is known exactly rather than on opaque fixtures.
 */

export interface JpegFixtureOptions {
  width: number;
  height: number;
  /** Omit for a JPEG without any EXIF segment. */
  exif?: {
    littleEndian?: boolean;
    orientation?: number;
    pixelWidth?: number;
    pixelHeight?: number;
    make?: string;
    thumbnail?: boolean;
  };
  /** SOF marker; 0xC0 baseline (default) or 0xC2 progressive. */
  sof?: number;
}

function u16(value: number, little: boolean): number[] {
  return little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
}

function u32(value: number, little: boolean): number[] {
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return little ? bytes.reverse() : bytes;
}

function flatten(lists: number[][]): number[] {
  return lists.reduce<number[]>((all, list) => all.concat(list), []);
}

function entry(tag: number, type: number, count: number, value: number[], little: boolean): number[] {
  const padded = value.concat([0, 0, 0, 0]).slice(0, 4);
  return [...u16(tag, little), ...u16(type, little), ...u32(count, little), ...padded];
}

function exifSegment(options: NonNullable<JpegFixtureOptions['exif']>): number[] {
  const little = options.littleEndian ?? true;
  const short = (value: number): number[] => u16(value, little);
  const long = (value: number): number[] => u32(value, little);

  const make = options.make ? [...options.make].map((char) => char.charCodeAt(0)).concat(0) : null;
  const hasExifIfd = options.pixelWidth !== undefined || options.pixelHeight !== undefined;

  // Layout: header (8) | IFD0 | Exif IFD | IFD1 | make string
  const ifd0Entries: number[][] = [];
  const ifd0Count = (options.orientation !== undefined ? 1 : 0) + (make ? 1 : 0) + (hasExifIfd ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifIfdOffset = 8 + ifd0Size;
  const exifCount = (options.pixelWidth !== undefined ? 1 : 0) + (options.pixelHeight !== undefined ? 1 : 0);
  const exifIfdSize = hasExifIfd ? 2 + exifCount * 12 + 4 : 0;
  const ifd1Offset = exifIfdOffset + exifIfdSize;
  const ifd1Size = options.thumbnail ? 2 + 2 * 12 + 4 : 0;
  const makeOffset = ifd1Offset + ifd1Size;

  if (make) {
    ifd0Entries.push(entry(0x010f, 2, make.length, make.length <= 4 ? make : long(makeOffset), little));
  }
  if (options.orientation !== undefined) {
    ifd0Entries.push(entry(0x0112, 3, 1, short(options.orientation), little));
  }
  if (hasExifIfd) {
    ifd0Entries.push(entry(0x8769, 4, 1, long(exifIfdOffset), little));
  }

  const tiff: number[] = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...short(42),
    ...long(8),
    ...short(ifd0Entries.length),
    ...flatten(ifd0Entries),
    ...long(options.thumbnail ? ifd1Offset : 0),
  ];

  if (hasExifIfd) {
    const entries: number[][] = [];
    if (options.pixelWidth !== undefined) {
      entries.push(entry(0xa002, 4, 1, long(options.pixelWidth), little));
    }
    if (options.pixelHeight !== undefined) {
      entries.push(entry(0xa003, 4, 1, long(options.pixelHeight), little));
    }
    tiff.push(...short(entries.length), ...flatten(entries), ...long(0));
  }
  if (options.thumbnail) {
    tiff.push(
      ...short(2),
      ...entry(0x0201, 4, 1, long(makeOffset + (make?.length ?? 0)), little),
      ...entry(0x0202, 4, 1, long(16), little),
      ...long(0),
    );
  }
  if (make && make.length > 4) {
    tiff.push(...make);
  }

  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  return [0xff, 0xe1, ...u16(payload.length + 2, false), ...payload];
}

/** A JPEG with the given header facts. It has no scan data and cannot be decoded as an image. */
export function jpegFixture(options: JpegFixtureOptions): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (options.exif) {
    bytes.push(...exifSegment(options.exif));
  }
  // SOF: length 11, precision 8, height, width, one component.
  bytes.push(0xff, options.sof ?? 0xc0, 0x00, 0x0b, 0x08, ...u16(options.height, false), ...u16(options.width, false));
  bytes.push(0x01, 0x01, 0x11, 0x00);
  // Start of scan (inspection stops here) and end of image.
  bytes.push(0xff, 0xda, 0x00, 0x02, 0xff, 0xd9);
  return new Uint8Array(bytes);
}

/** A PNG signature followed by an IHDR chunk; enough for format and size detection. */
export function pngFixture(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13, false),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width, false),
    ...u32(height, false),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}
