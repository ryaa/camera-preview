import { Component, computed, inject, signal } from '@angular/core';

import { CameraHarnessService } from '../../harness/camera-harness.service';
import { describeOrientation } from '../../harness/image-inspector';

interface Row {
  label: string;
  value: string;
  /** Marks a row whose value contradicts what the platform is expected to return. */
  warn?: boolean;
}

const NOT_APPLICABLE = 'not applicable';

function size(width: number | null, height: number | null): string {
  return width !== null && height !== null ? `${width} × ${height}` : 'could not be read';
}

function aspect(value: number | null): string {
  return value === null ? '—' : value.toFixed(4);
}

/**
 * Shows the last image or video with facts read from the encoded bytes. The image is never cropped
 * to fit (object-fit: contain on a checkerboard), because a cropped thumbnail hides the aspect and
 * orientation differences this harness is for.
 */
@Component({
  selector: 'app-result-panel',
  templateUrl: 'result-panel.component.html',
})
export class ResultPanelComponent {
  protected readonly harness = inject(CameraHarnessService);

  protected readonly zoom = signal<'fit' | 'actual'>('fit');
  /** What the WebView reports for the decoded image; it has already applied the EXIF orientation. */
  protected readonly natural = signal<{ width: number; height: number } | null>(null);
  protected readonly videoMeta = signal<{ duration: number; width: number; height: number } | null>(null);
  protected readonly videoError = signal<string | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const image = this.harness.lastImage();
    if (!image) {
      return [];
    }

    const { diagnostics } = image;
    const { classification, info } = diagnostics;
    const rows: Row[] = [
      { label: 'Call', value: `${diagnostics.method}() #${diagnostics.callId}` },
      {
        label: 'Returned value',
        value:
          classification.detected.kind === 'file'
            ? (diagnostics.returnedPath ?? '')
            : `${classification.detected.kind} data, ${diagnostics.returnedLength} characters`,
      },
      {
        label: 'Expected for this platform',
        value: `${classification.expected.kind}${
          classification.expected.format ? `, ${classification.expected.format}` : ''
        } — ${classification.note}`,
        warn: !classification.consistent,
      },
    ];

    if (diagnostics.webViewUrl) {
      rows.push({ label: 'WebView URL', value: diagnostics.webViewUrl });
    }
    if (diagnostics.readError) {
      rows.push({ label: 'Bytes', value: `could not be read: ${diagnostics.readError}`, warn: true });
    }
    if (!info) {
      return rows;
    }

    const jpeg = info.jpeg;
    const formatLabel = info.format === 'unknown' ? 'unknown (neither JPEG nor PNG)' : info.format.toUpperCase();
    rows.push(
      { label: 'Format (from bytes)', value: formatLabel, warn: info.format === 'unknown' },
      { label: 'Bytes', value: `${info.byteLength}` },
      { label: 'Encoded size (from header)', value: size(info.encodedWidth, info.encodedHeight) },
      {
        label: 'EXIF orientation (raw)',
        value: jpeg
          ? jpeg.hasExif
            ? describeOrientation(jpeg.orientation)
            : 'no EXIF block'
          : `${NOT_APPLICABLE} (${formatLabel})`,
      },
      { label: 'As displayed (orientation applied)', value: size(info.displayWidth, info.displayHeight) },
    );

    const natural = this.natural();
    rows.push({
      label: 'Browser-normalised size',
      value: natural
        ? `${natural.width} × ${natural.height} — the WebView has already applied EXIF`
        : 'not decoded by the WebView yet',
    });

    if (jpeg) {
      if (jpeg.exifPixelWidth !== null || jpeg.exifPixelHeight !== null) {
        const stale =
          (jpeg.exifPixelWidth !== null && jpeg.exifPixelWidth !== info.encodedWidth) ||
          (jpeg.exifPixelHeight !== null && jpeg.exifPixelHeight !== info.encodedHeight);
        rows.push({
          label: 'EXIF PixelX/YDimension',
          value: `${size(jpeg.exifPixelWidth, jpeg.exifPixelHeight)}${stale ? ' — differs from the encoded size' : ''}`,
          warn: stale,
        });
      }
      if (jpeg.hasExif) {
        rows.push({ label: 'EXIF thumbnail', value: jpeg.hasThumbnail ? 'present' : 'none' });
      }
      const camera = [jpeg.make, jpeg.model].filter((part) => part).join(' ');
      if (camera) {
        rows.push({ label: 'EXIF make / model', value: camera });
      }
      if (jpeg.dateTime) {
        rows.push({ label: 'EXIF DateTime', value: jpeg.dateTime });
      }
    } else {
      rows.push({ label: 'JPEG metadata', value: `${NOT_APPLICABLE} (${formatLabel})` });
    }

    rows.push({
      label: 'Preview aspect / output aspect',
      value:
        diagnostics.previewAspect === null
          ? `— / ${aspect(diagnostics.outputAspect)} (no preview rectangle on this platform)`
          : `${aspect(diagnostics.previewAspect)} / ${aspect(diagnostics.outputAspect)}${
              diagnostics.aspectDeltaPercent === null ? '' : ` — Δ ${diagnostics.aspectDeltaPercent.toFixed(1)} %`
            }`,
      warn: diagnostics.aspectDeltaPercent !== null && Math.abs(diagnostics.aspectDeltaPercent) > 1,
    });

    return rows;
  });

  protected onImageLoad(event: Event): void {
    if (event.target instanceof HTMLImageElement) {
      this.natural.set({ width: event.target.naturalWidth, height: event.target.naturalHeight });
    }
  }

  protected onVideoMeta(event: Event): void {
    if (event.target instanceof HTMLVideoElement) {
      this.videoError.set(null);
      this.videoMeta.set({
        duration: event.target.duration,
        width: event.target.videoWidth,
        height: event.target.videoHeight,
      });
    }
  }

  protected onVideoError(): void {
    this.videoMeta.set(null);
    this.videoError.set('The WebView could not load this file.');
  }

  protected toggleZoom(): void {
    this.zoom.set(this.zoom() === 'fit' ? 'actual' : 'fit');
  }

  protected clear(): void {
    this.natural.set(null);
    this.videoMeta.set(null);
    this.harness.clearResults();
  }
}
