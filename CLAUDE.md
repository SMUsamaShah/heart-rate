# CLAUDE.md — Heart Rate Monitor (Pulse Monitor PWA)

## Project Overview

A standalone, offline-capable Progressive Web App (PWA) for real-time heart rate monitoring using the smartphone camera. It uses **photoplethysmography (PPG)** — extracting the green channel from camera frames to detect blood volume pulse variations.

**Live demo:** https://raw.githack.com/SMUsamaShah/heart-rate/claude/offline-pwa-setup-oFAtx/index.html

---

## Repository Structure

```
heart-rate/
├── index.html      # Single-page app: HTML structure + all embedded CSS
├── script.js       # All application logic (modules listed below)
├── sw.js           # Service worker (offline caching, cache-first strategy)
├── manifest.json   # PWA manifest (app name, icon, display mode)
├── icon.svg        # SVG app icon (heart + ECG waveform)
├── test/
│   ├── harness.js    # Loads script.js unmodified into a Node vm sandbox (DOM stubs, seeded RNG)
│   └── run-tests.js  # Headless regression suite for beat detection + simulation
└── README.md       # Brief project description
```

**No build system, no dependencies, no package.json.** Deploy by serving static files directly. Tests run with plain Node (`node test/run-tests.js`).

---

## Architecture

All logic lives in `script.js`, organized into 8 modules using object/closure patterns with a shared `AppState` object.

### Module Overview

| Module | Responsibility |
|--------|----------------|
| `CONSTANTS` | Immutable configuration for signal processing, beat detection, simulation, storage limits |
| `Config` | Persistent user settings (localStorage-backed), defaults and load/save |
| `Camera` | getUserMedia, torch/flashlight, rear camera, stream cleanup |
| `WakeLock` | Screen wake lock acquisition/release |
| `SignalProcessor` | PPG signal extraction, adaptive normalization, demo-mode simulation |
| `BandpassFilter` | First-order high-pass + low-pass (used when FFT mode is enabled) |
| `FFTAnalyzer` / `fftMagnitude` | Frequency-domain BPM estimate (optional, Settings toggle) |
| `BeatDetector` | Real-time beat detection and BPM calculation (also replayed for review mode) |
| `Renderer` | Canvas waveform drawing, beat markers, threshold line, time markers |
| `Storage` | localStorage CRUD, quota management, export |
| `UI` + Event Handlers | Tab switching, mode management, animation loop |

### Application Modes

```
idle  →  camera  (tap canvas, real camera)
idle  →  simulate  (Settings: Simulate button)
camera/simulate  →  idle  (tap canvas again, or auto-stop)
idle  →  review  (tap a history entry)
review  →  idle  (tap canvas or Done)
```

Mode transitions are managed by `AppState.mode` via `setMode()`; review mode is entered through `openReview()`.

---

## Key Algorithms

### PPG Signal Processing (`SignalProcessor`)

1. **Frame capture:** Camera frame → 30×30 pixel downsample → average green channel intensity
2. **Saturation detection:** Flags overexposed frames (intensity > 250)
3. **Normalization:** Adaptive gain control over a 120-frame sliding window; exponential smoothing (factor: gain smoothing constant); output clamped to `[-0.6, 0.6]`

### Beat Detection (`BeatDetector`)

- Maintains a **running maximum** with time-based decay (`DECAY_PER_SECOND`, ≈0.99/frame at 30fps) so the threshold behaves the same at 15/30/60fps
- **Dynamic threshold** = 45% of running max (minimum baseline enforced)
- **Refractory period** = 200–1000ms, adapting to `REFRACTORY_FACTOR` (0.45) × current beat interval. **The factor must stay < 0.5**: at ≥ 0.5, a sudden heart-rate rise (e.g. 75 → 200 BPM) makes every other beat land inside the refractory window and the detector locks permanently onto half the real rate. This is covered by a regression test.
- **BPM** = trimmed mean (drop top/bottom quarter) of the last N inter-beat intervals (default window: 8 beats), smoothed with factor 0.7. The trimming makes a missed beat (2× interval) or stray double-detection (0.5× interval) unable to drag the displayed BPM.
- Review mode replays saved samples through the same `BeatDetector.process()` used live, so review and live output are identical.

### Simulation (`generateSimulation(dt, targetBpm)`)

Generates a synthetic PPG-like signal with real-world imperfections (constants in `CONSTANTS.SIMULATION`):
- Gaussian QRS-like main peak + smaller dicrotic-like secondary wave
- **Heart-rate variability**: each beat's duration jitters ±4%; slider changes apply at beat boundaries (no phase jump)
- **Per-beat amplitude variation** (±15%), **white noise**, **slow baseline wander** (~0.25 Hz respiratory drift), and rare **motion-artifact spikes**

This makes demo mode a realistic stress test of the detector; the test suite asserts the detector reads back whatever BPM the slider is set to.

---

## Data Storage

- **API:** `localStorage`
- **Record format** (`v` must equal `CONSTANTS.VERSION`, currently 4; `duration` and sample `t` are in seconds):
  ```json
  {
    "id": 1234567890123,
    "v": 4,
    "timestamp": "2026-01-01T10:00:00.000Z",
    "duration": 60.0,
    "avgBpm": 72,
    "samples": [{ "t": 0, "v": 0.3 }, ...]
  }
  ```
- **Version field (`v`):** Records with wrong version are filtered out on load
- **Max records:** Configurable (`Config.maxRecords`, Settings tab)
- **Max storage:** 5 MB quota; triggers oldest-batch deletion at 95% usage
- **Export:** JSON blob download via `Storage.exportAll()`

---

## Service Worker (`sw.js`)

- **Cache name:** `CACHE_NAME` in `sw.js` (increment version string to force cache refresh). `APP_CACHE` in `script.js` must be kept in sync — it drives the version display in Settings.
- **Cached assets:** `./`, `./index.html`, `./script.js`, `./manifest.json`, `./icon.svg`
- **Strategy:** Cache-first, network fallback
- **Activation:** `skipWaiting()` + deletes previous cache versions

To bust the cache after changes, update the `CACHE_NAME` constant in `sw.js`.

---

## Conventions

### Naming

- **Variables/functions:** `camelCase`
- **Constants:** `UPPER_SNAKE_CASE` (defined in the `CONSTANTS` object at the top of `script.js`)
- **DOM references:** Centralized in the `DOM` object — always add new element refs there

### Code Organization

- Section headers use `// ============` delimiters
- Module state is kept private via closures; public API exposed as object properties
- Global shared state lives in `AppState` — keep this minimal
- Settings that should persist across sessions go in `Config` (auto-serialized to localStorage)

### CSS

- All CSS is embedded in `<style>` within `index.html` — no external stylesheets
- Mobile-first, responsive; uses CSS custom properties and `env(safe-area-inset-*)` for notch support
- No CSS framework or preprocessor

### No Build Step

- Edit files directly; there is no compilation, bundling, or transpilation
- Test by opening `index.html` in a browser (requires HTTPS or localhost for camera access)
- Service worker only activates over HTTPS or `localhost`

---

## Development Workflow

### Local Testing

```bash
# Serve locally (required for camera/SW APIs)
python3 -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080` in a mobile browser or desktop Chrome with DevTools device emulation.

### Camera Testing on Desktop

- Use Chrome DevTools → More tools → Sensors to simulate, or
- Use the built-in **Simulate mode** (Settings tab → Simulate button + Target BPM slider) which runs `generateSimulation()` instead of the camera

### Making Changes

1. Edit `index.html` (HTML structure or CSS) or `script.js` (logic)
2. If you add new cached assets, update the `ASSETS` array in `sw.js`
3. If the record data format changes, increment `CONSTANTS.VERSION` and update the record format documentation above
4. If cache-busting is needed, increment `CACHE_NAME` in `sw.js` (and `APP_CACHE` in `script.js`)
5. Run `node test/run-tests.js` and keep it green

### Automated Tests

```bash
node test/run-tests.js                 # test ./script.js (exit code 0 = green)
node test/run-tests.js /path/to/old.js # run the same suite against another version
```

The suite loads the **real, unmodified `script.js`** into a Node `vm` sandbox (`test/harness.js` stubs the DOM and seeds `Math.random`, so runs are deterministic) and drives synthetic PPG signals through the same `SignalProcessor.normalize → BeatDetector.process` path the browser uses. Coverage:

- Steady-rate accuracy 50–240 BPM at 15/30/60fps
- **Regression: sudden 70 → 200 BPM rise** (field-reported half-rate lock; must recover within 20s)
- Gradual ramps, sudden drops, heavy noise at 200 BPM, dicrotic-notch double-count rejection
- Demo-mode pipeline: simulated signal at the slider BPM must read back within tolerance
- Simulation realism: noise present, reproducible by seed, HRV jitter in range
- FFT mode estimate at 200 BPM
- Mode/state-machine regressions (driven through the real `setMode`/`openReview`/`saveRecording` with faked `getUserMedia`): transitions requested mid-transition are queued rather than dropped, mode-owned overlays are cleared on every transition, concurrent Save taps store a single record, Save button hidden for un-saveable captures

When changing detector or simulation constants, add/adjust a scenario rather than hand-tuning blind.

### Manual Verification

Still verify in a browser what the harness cannot cover:
- Camera start/stop (requires physical device or emulation)
- Beat detection accuracy (compare BPM readout against known pulse)
- Recording save/load/delete/export
- Demo (simulation) mode
- Review mode playback with slider
- PWA install and offline behavior

---

## Important Constants (in `CONSTANTS` at the top of `script.js`)

| Constant | Purpose |
|----------|---------|
| `SIGNAL.WARMUP_FRAMES` | Frames to discard on camera start for sensor stabilization |
| `SIGNAL.NORMALIZATION_WINDOW` | Normalization sliding window size (frames) |
| `BEAT_DETECTION.DECAY_PER_SECOND` | Time-based running-max decay (frame-rate independent) |
| `BEAT_DETECTION.REFRACTORY_MIN/MAX_MS` | Beat detector lockout range (ms) |
| `BEAT_DETECTION.REFRACTORY_FACTOR` | Refractory as fraction of beat interval — **must stay < 0.5** (see Beat Detection) |
| `BPM.DEFAULT_WINDOW` | Number of beats used for the trimmed-mean BPM |
| `BPM.SMOOTHING` | Exponential smoothing factor for BPM display |
| `SIMULATION.HRV_JITTER` etc. | Demo-mode realism: HRV, amplitude jitter, noise, wander, artifacts |
| `STORAGE.QUOTA_CRITICAL` | localStorage usage fraction triggering auto-deletion |
| `VERSION` | Record format version; increment on schema changes |

---

## PWA Notes

- The app is installable on Android and iOS (as "Add to Home Screen")
- `manifest.json` declares `display: standalone` and portrait orientation
- Wake Lock keeps screen on during recording (degrades gracefully if unsupported)
- Torch/flashlight is requested via `torch: true` constraint for better signal on dark fingers

---

## Branch Naming

Past branches follow the pattern `claude/<description>-<id>`. New feature branches should follow the same convention.
