import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import type { AfterViewInit, OnDestroy } from '@angular/core';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { IonContent } from '@ionic/angular/standalone';
import type { ViewWillLeave } from '@ionic/angular/standalone';

import { createAutomationApi, loadAutorunPlan, runAutorun } from '../harness/automation';
import { CameraHarnessService } from '../harness/camera-harness.service';
import { HarnessUiService, PANELS } from '../harness/harness-ui.service';
import { WEB_PARENT_ID } from '../harness/presets';

import { ConfigPanelComponent } from './panels/config-panel.component';
import { CoveragePanelComponent } from './panels/coverage-panel.component';
import { LabPanelComponent } from './panels/lab-panel.component';
import { LivePanelComponent } from './panels/live-panel.component';
import { LogPanelComponent } from './panels/log-panel.component';
import { ResultPanelComponent } from './panels/result-panel.component';

/** Typical status-bar and gesture-bar heights in dp; used only when the WebView reports no insets. */
const ANDROID_FALLBACK_TOP_INSET = 28;
const ANDROID_FALLBACK_BOTTOM_INSET = 20;

/**
 * Shell of the test harness: a status strip, the panel tabs, the selected panel and a control dock
 * that stays reachable whatever the preview covers. All plugin calls go through
 * {@link CameraHarnessService}; this page only arranges the controls around the native preview.
 */
@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    IonContent,
    ConfigPanelComponent,
    CoveragePanelComponent,
    LabPanelComponent,
    LivePanelComponent,
    LogPanelComponent,
    ResultPanelComponent,
  ],
})
export class HomePage implements AfterViewInit, OnDestroy, ViewWillLeave {
  protected readonly harness = inject(CameraHarnessService);
  protected readonly ui = inject(HarnessUiService);

  protected readonly panels = PANELS;
  protected readonly webParentId = WEB_PARENT_ID;

  protected readonly readyText = computed(() => {
    const ready = this.harness.ready();
    switch (ready.value) {
      case 'unsupported':
        return 'isCameraStarted(): not available on this platform';
      case 'unknown':
        return 'isCameraStarted(): —';
      case 'error':
        return 'isCameraStarted(): rejected';
      default:
        return `isCameraStarted(): ${ready.value}`;
    }
  });

  protected readonly lastCallText = computed(() => {
    const call = this.harness.lastCall();
    if (!call) {
      return 'no call yet';
    }
    const detail =
      call.outcome === 'rejected'
        ? `: ${call.error ?? ''}${call.expectedUnsupported ? ' (unsupported here — expected)' : ''}`
        : '';
    return `${call.method}() ${call.outcome} in ${call.durationMs} ms${detail}`;
  });

  protected readonly guide = computed(() => {
    const rect = this.harness.previewRect();
    if (!rect || !this.ui.showGuide() || this.ui.chromeHidden() || rect.height <= 0) {
      return null;
    }
    // After a rotation the rectangle is no longer the requested one but what the native layout
    // rules make of it; say so, because the two can differ in more than orientation.
    const origin = this.harness.previewRectSource() === 'requested' ? 'requested' : 'expected after rotation';
    return {
      rect,
      label: `${origin} ${Math.round(rect.width)} × ${Math.round(rect.height)} · aspect ${(rect.width / rect.height).toFixed(3)}`,
    };
  });

  private readonly dock = viewChild<ElementRef<HTMLElement>>('dock');
  private readonly probe = viewChild<ElementRef<HTMLElement>>('probe');
  private readonly listeners: Promise<PluginListenerHandle>[] = [];
  private readonly onResize = (): void => this.measure();
  private dockObserver: ResizeObserver | undefined;

  public ngAfterViewInit(): void {
    window.addEventListener('resize', this.onResize);
    const dock = this.dock()?.nativeElement;
    if (dock && typeof ResizeObserver !== 'undefined') {
      this.dockObserver = new ResizeObserver(() => this.measure());
      this.dockObserver.observe(dock);
    }
    this.measure();

    this.listeners.push(
      App.addListener('pause', () => this.harness.lifecycle('app: pause')),
      App.addListener('resume', () => this.harness.lifecycle('app: resume')),
      App.addListener('appStateChange', ({ isActive }) =>
        this.harness.lifecycle(`app: ${isActive ? 'active' : 'inactive'}`),
      ),
      // While a preview is running the hardware back button stops it, so a preview that covers the
      // page can always be dismissed; otherwise it leaves the app as usual.
      App.addListener('backButton', () => {
        if (this.harness.sessionActive()) {
          this.harness.lifecycle('hardware back: stopping the preview');
          void this.harness.stop();
        } else {
          void App.minimizeApp();
        }
      }),
    );

    const api = createAutomationApi(this.harness, this.ui);
    window.__cameraPreviewHarness = api;
    void loadAutorunPlan().then((plan) => runAutorun(api, this.ui, plan));
  }

  public ionViewWillLeave(): void {
    void this.harness.reset();
  }

  public ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.dockObserver?.disconnect();
    for (const listener of this.listeners) {
      void listener.then((handle) => handle.remove());
    }
    delete window.__cameraPreviewHarness;
    void this.harness.reset();
  }

  protected async start(): Promise<void> {
    await this.ui.startFromForm();
  }

  protected stop(): void {
    void this.harness.stop();
  }

  protected async capture(): Promise<void> {
    const { record } = await this.harness.capture(this.ui.captureOptions());
    if (record.outcome === 'resolved') {
      this.ui.panel.set('results');
    }
  }

  protected async sample(): Promise<void> {
    const { record } = await this.harness.captureSample(this.ui.sampleOptions());
    if (record.outcome === 'resolved') {
      this.ui.panel.set('results');
    }
  }

  protected flip(): void {
    void this.harness.flip();
  }

  protected reset(): void {
    this.ui.peek.set(false);
    void this.harness.reset();
  }

  /**
   * Android WebViews older than 140 report no safe-area insets, yet Capacitor 8 lays the page out
   * under the system bars (and publishes the insets itself only from Android 15). When the page
   * spans the whole screen and no inset is known, reserve a typical status-bar and gesture-bar
   * height so the controls are not drawn underneath them.
   */
  private applyInsetFallback(probe: HTMLElement): void {
    const root = document.documentElement;
    root.style.removeProperty('--cph-fallback-top');
    root.style.removeProperty('--cph-fallback-bottom');

    const reported = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    const edgeToEdge = window.innerHeight >= window.screen.height;
    if (this.harness.platform === 'android' && reported === 0 && edgeToEdge) {
      root.style.setProperty('--cph-fallback-top', `${ANDROID_FALLBACK_TOP_INSET}px`);
      root.style.setProperty('--cph-fallback-bottom', `${ANDROID_FALLBACK_BOTTOM_INSET}px`);
    }
  }

  /**
   * Reads the viewport, the top safe-area inset (from a probe element) and the dock height, then
   * lets a running preview's rectangle follow the change (a rotation, most of all).
   */
  private measure(): void {
    this.ui.viewport.set({ width: window.innerWidth, height: window.innerHeight });

    const probe = this.probe()?.nativeElement;
    if (probe) {
      this.applyInsetFallback(probe);
      this.ui.safeTop.set(Math.round(parseFloat(getComputedStyle(probe).paddingTop) || 0));
    }
    const dockHeight = this.dock()?.nativeElement.getBoundingClientRect().height ?? 0;
    // A hidden dock measures 0; keep the last real height so presets stay meaningful while peeking.
    if (dockHeight > 0) {
      this.ui.dockHeight.set(Math.round(dockHeight));
    }
    // Last, so a running preview's rectangle is re-evaluated against the metrics just measured.
    this.ui.viewportChanged();
  }
}
