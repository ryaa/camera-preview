# Example-app end-to-end runs

Three scripts drive the example app through its automation entry point,
`window.__cameraPreviewHarness`, so an automated run executes the same code a manual tap does.
They need Node 22 or newer and nothing else: no test framework and no extra packages.

| Script | Target | What it is evidence of |
|---|---|---|
| `android-baseline.mjs` | Android emulator or device, over `adb` and the WebView's DevTools socket | What the plugin's Android backend does: every method and option, geometry measured from screenshots, concurrency, lifecycle, permissions, recording |
| `web-smoke.mjs` | Headless Chrome with a fake camera | The shared example app and the web implementation |
| `ios-smoke.mjs` | iOS simulator (no camera) | The example app builds, launches and renders on iOS, and every call settles or is reported as unsettled |

A build that compiles, or a screenshot nobody measured, is not camera evidence. The simulator and
web runs say nothing about a native camera, and nothing here replaces a physical device for flash,
focus, image quality or vendor behaviour.

## Results

Every run writes `results.json`, `summary.md` and its artefacts (untouched image bytes, screenshots,
logs) to `e2e/out/<run>/`, or to the folder given with `--out`. Each check has a status
(`passed`, `failed`, `blocked`, `not run`, `unsupported`) and a type:

- **baseline** — behaviour of the current implementation that a replacement has to reproduce, or
  change only by a recorded decision.
- **known-defect** — an existing defect the run is expected to reproduce. `passed` means it was
  observed as recorded; `failed` means the behaviour changed.
- **harness** — a check of the harness itself, for example that the in-app image reader and the
  host's independent reader agree.

The exit code is 0 only when no check failed. A complete Android run additionally needs a snapshot
to compare with: without one it ends with a `blocked` snapshot check and a non-zero exit code.

What the checks do not show:

- A lab check passes when no call is left unsettled within its deadline. JavaScript cannot see
  whether the native side tried to settle a call twice; the plugin's coordinator and router unit
  tests are the evidence for that.
- The readiness samples taken while `start()` is pending are logged, not asserted. They are not
  evidence of when the first frame arrived.
- The coverage check says that every method and option was *sent* at least once. It does not say
  that the effect of every option was verified.

## Android baseline

```sh
npm run build:dev:android:sync                # web bundle + cap sync
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
node e2e/android-baseline.mjs                 # or: npm run e2e:android
```

The device is selected the way `adb` does it (`ANDROID_SERIAL`, or the only one connected). An
emulator must have cameras: start it with `-camera-back emulated -camera-front emulated`. Adding
`-read-only` leaves the AVD untouched, and `-no-audio` keeps the host microphone out of it.

| Option | Meaning |
|---|---|
| `--out <dir>` | Where to write the results |
| `--only A,F1` / `--skip T,U` | Run or skip cases by id. A partial run neither compares nor records the snapshot |
| `--record` | Create or replace the snapshot for this device configuration from this run |
| `--extend V,R4` | Add the named cases to an existing snapshot if it does not have them yet; compare everything else |
| `--accept <check ids>` | Checks that may be failed or blocked in a run that is recorded or used to extend |
| `--port <n>` | Local port forwarded to the WebView (default 9222) |

Besides the checks, the run produces a **snapshot**: every outcome, rejection message, image format,
encoded size and EXIF orientation it saw, without timings or payload sizes. It is compared with
`e2e/baseline/android-<device key>.json`, where the key is the API level, the display size and the
density. A difference means the behaviour of the backend changed on that configuration; whether that
is a regression or an intended change is a decision, and the snapshot is re-recorded only after it
has been made.

A snapshot is written only on request:

- Without `--record` or `--extend` the run compares and never writes. If there is no snapshot for
  the device configuration, the snapshot check is `blocked` and the run fails; the behaviour it saw
  is not accepted as a reference by default.
- `--record` creates or replaces the snapshot. Use it on the backend that is to be the reference
  (today: Camera1), not on the one being judged.
- `--extend <cases>` is for a case that was added to the runner after the snapshot was recorded. It
  appends the named cases and compares every other case as usual; a case the snapshot already has is
  never replaced, and nothing is written if a recorded case differs.
- Neither writes when the run has failed or blocked checks, because such a run must not become the
  reference. A check that is expected to be blocked on a device (for example `I/default-is-rear`
  where both cameras look alike) can be named with `--accept`.

Cases `T` and `U` revoke permissions, which restarts the app; `R3` and `U` are expected to end the app
process with the current backend, and the run relaunches it. Cases `S` and `V` turn the display with
`settings put system user_rotation` and turn it back.

Case `R2` asserts that a recording limited with `maxDuration: 1500` lasts between 1.0 and 2.5 s
although `stopRecordVideo()` is called only after 4 s: half a second under the limit for frames lost
while the encoder starts, one second over it for the recorder to notice the limit and finalise the
file. The duration itself is not part of the snapshot. Case `R4` records what `captureSample()` and
`capture()` answer once a recording has passed its `maxDuration` and before `stopRecordVideo()`.
Case `V` measures the native preview after each turn of the device and compares it with the
rectangle the harness expects. For its wide rectangle it also allows the automatic stop for one
turn: that turn leaves the rectangle as it is but takes away the room for the controls, and the
check is that the countdown is armed all the same.

The run turns off the harness's automatic stop (it needs no controls), and after each case it notes
when the app was paused by something outside the run — a system dialog shortly after an emulator
has booted, for example — because such a pause can change what a call answers. Let a freshly booted
emulator settle for a minute before starting a run.

## Web smoke

```sh
npx ng build --configuration development
node e2e/web-smoke.mjs                        # or: npm run e2e:web
```

Chrome is taken from `CHROME_BIN`, or from its default location. The script serves `www/browser`
itself and removes its temporary browser profile afterwards.

## iOS simulator smoke

```sh
npx ng build --configuration development && npx cap sync --inline ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath <dir> CODE_SIGNING_ALLOWED=NO build
node e2e/ios-smoke.mjs --app <dir>/Build/Products/Debug-iphonesimulator/App.app --runtime 26.5
```

No debugger can be attached to the simulator's WebView from a script, so this run uses the app's
autorun file instead. The script copies the built app, writes a plan into the copy's
`public/assets/harness-autorun.json`, installs and launches it on a temporary simulator, and reads
the results from the app's console. The file committed in `src/assets/` has `"enabled": false`, so a
normal build runs nothing on launch.

Without `--device <udid>` the script creates a simulator and deletes it at the end. `--runtime`
selects the iOS version; without it the newest installed runtime is used.

Only screenshots taken by the run itself count for its checks. Each capture first removes the file
it is about to write, so in a reused output folder a screenshot of an earlier run can neither satisfy
a check nor be mistaken for a new one.

## Unit tests

```sh
npm run test:ci        # ng test --watch=false --browsers=ChromeHeadless
npm run test:e2e       # node --test "e2e/test/*.test.mjs"
```

The first covers the pure harness modules (option model, presets and rotation geometry, capability
table, image inspector, result classifier, event log), the service that wraps every plugin call
(including which results may still be published, and which calls may still change the recording
state, after a reset or a restart), the control-recovery rules of the page, the automation entry
point, and the page. The second covers the runners' own helpers: the snapshot comparison and the
screenshot tracker.
