import {
  base64ToBytes,
  bytesToBase64,
  describeOrientation,
  detectImageFormat,
  fileExtensionFor,
  inspectImage,
  mimeTypeFor,
} from './image-inspector';
import { jpegFixture, pngFixture } from './testing/image-fixtures';

describe('image-inspector', () => {
  describe('format detection', () => {
    it('recognises JPEG, PNG and neither from the first bytes', () => {
      expect(detectImageFormat(jpegFixture({ width: 4, height: 3 }))).toBe('jpeg');
      expect(detectImageFormat(pngFixture(4, 3))).toBe('png');
      expect(detectImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('unknown');
      expect(detectImageFormat(new Uint8Array([]))).toBe('unknown');
    });

    it('maps formats to MIME types and file extensions', () => {
      expect(mimeTypeFor('jpeg')).toBe('image/jpeg');
      expect(mimeTypeFor('png')).toBe('image/png');
      expect(fileExtensionFor('jpeg')).toBe('jpg');
      expect(fileExtensionFor('png')).toBe('png');
      expect(fileExtensionFor('unknown')).toBe('bin');
    });
  });

  describe('JPEG', () => {
    it('reads the encoded size from the start-of-frame marker', () => {
      const info = inspectImage(jpegFixture({ width: 1280, height: 720 }));

      expect(info.format).toBe('jpeg');
      expect(info.encodedWidth).toBe(1280);
      expect(info.encodedHeight).toBe(720);
      expect(info.png).toBeNull();
    });

    it('reports a JPEG without an EXIF segment as having no EXIF, not as orientation 1', () => {
      const info = inspectImage(jpegFixture({ width: 720, height: 1280 }));

      expect(info.jpeg?.hasExif).toBeFalse();
      expect(info.jpeg?.orientation).toBeNull();
      expect(info.displayWidth).toBe(720);
      expect(info.displayHeight).toBe(1280);
    });

    it('reads the raw orientation and swaps the displayed size for transposing orientations', () => {
      const info = inspectImage(jpegFixture({ width: 1280, height: 720, exif: { orientation: 6 } }));

      expect(info.jpeg?.hasExif).toBeTrue();
      expect(info.jpeg?.orientation).toBe(6);
      // Encoded size is untouched; only the displayed size is rotated.
      expect(info.encodedWidth).toBe(1280);
      expect(info.encodedHeight).toBe(720);
      expect(info.displayWidth).toBe(720);
      expect(info.displayHeight).toBe(1280);
    });

    it('does not swap the displayed size for orientations 1 to 4', () => {
      for (const orientation of [1, 2, 3, 4]) {
        const info = inspectImage(jpegFixture({ width: 1920, height: 1080, exif: { orientation } }));
        expect(info.displayWidth).withContext(`orientation ${orientation}`).toBe(1920);
        expect(info.displayHeight).withContext(`orientation ${orientation}`).toBe(1080);
      }
    });

    it('swaps for every transposing orientation, 5 to 8', () => {
      for (const orientation of [5, 6, 7, 8]) {
        const info = inspectImage(jpegFixture({ width: 1920, height: 1080, exif: { orientation } }));
        expect(info.displayWidth).withContext(`orientation ${orientation}`).toBe(1080);
        expect(info.displayHeight).withContext(`orientation ${orientation}`).toBe(1920);
      }
    });

    it('reads big-endian EXIF as well as little-endian', () => {
      const info = inspectImage(
        jpegFixture({ width: 640, height: 480, exif: { littleEndian: false, orientation: 8, pixelWidth: 640 } }),
      );

      expect(info.jpeg?.orientation).toBe(8);
      expect(info.jpeg?.exifPixelWidth).toBe(640);
    });

    it('reports an EXIF block without an orientation tag as such', () => {
      const info = inspectImage(jpegFixture({ width: 640, height: 480, exif: { make: 'Example Camera Co' } }));

      expect(info.jpeg?.hasExif).toBeTrue();
      expect(info.jpeg?.orientation).toBeNull();
      expect(info.jpeg?.make).toBe('Example Camera Co');
    });

    it('reads the EXIF pixel dimensions and the presence of a thumbnail', () => {
      const info = inspectImage(
        jpegFixture({
          width: 1010,
          height: 1920,
          exif: { orientation: 1, pixelWidth: 4624, pixelHeight: 3468, thumbnail: true, make: 'Maker' },
        }),
      );

      // Stale EXIF dimensions and a leftover thumbnail are what a careless crop-and-re-encode leaves behind.
      expect(info.jpeg?.exifPixelWidth).toBe(4624);
      expect(info.jpeg?.exifPixelHeight).toBe(3468);
      expect(info.jpeg?.hasThumbnail).toBeTrue();
      expect(info.jpeg?.make).toBe('Maker');
      expect(info.encodedWidth).toBe(1010);
    });

    it('recognises a progressive start-of-frame marker', () => {
      const info = inspectImage(jpegFixture({ width: 800, height: 600, sof: 0xc2 }));

      expect(info.jpeg?.sofMarker).toBe(0xc2);
      expect(info.encodedWidth).toBe(800);
    });

    it('survives truncated data without throwing', () => {
      const full = jpegFixture({ width: 1280, height: 720, exif: { orientation: 6, pixelWidth: 1280, thumbnail: true } });

      for (let length = 0; length < full.length; length++) {
        expect(() => inspectImage(full.slice(0, length)))
          .withContext(`${length} bytes`)
          .not.toThrow();
      }
    });
  });

  describe('PNG', () => {
    it('reads the size from IHDR and leaves JPEG-only facts unset', () => {
      const info = inspectImage(pngFixture(640, 480));

      expect(info.format).toBe('png');
      expect(info.encodedWidth).toBe(640);
      expect(info.encodedHeight).toBe(480);
      expect(info.displayWidth).toBe(640);
      expect(info.displayHeight).toBe(480);
      // No JPEG details at all: the UI labels EXIF as "not applicable" rather than "missing".
      expect(info.jpeg).toBeNull();
      expect(info.png).toEqual({ bitDepth: 8, colorType: 6 });
    });
  });

  describe('unknown data', () => {
    it('reports only the byte length', () => {
      const info = inspectImage(new Uint8Array([1, 2, 3, 4, 5]));

      expect(info).toEqual({
        format: 'unknown',
        byteLength: 5,
        encodedWidth: null,
        encodedHeight: null,
        displayWidth: null,
        displayHeight: null,
        jpeg: null,
        png: null,
      });
    });
  });

  it('describes orientations, including a missing tag and an invalid value', () => {
    expect(describeOrientation(6)).toContain('90° clockwise');
    expect(describeOrientation(null)).toBe('no orientation tag');
    expect(describeOrientation(9)).toContain('not a valid');
  });

  it('round-trips bytes through base64, across the chunk boundary', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = (index * 31) & 0xff;
    }

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
