# CLAUDE.md — Heart Rate Monitor (Pulse Monitor PWA)

## Project Overview

A standalone, offline-capable Progressive Web App (PWA) for real-time heart rate monitoring using the smartphone camera. It uses **photoplethysmography (PPG)** — extracting the green channel from camera frames to detect blood volume pulse variations.

**Live demo:** https://raw.githack.com/SMUsamaShah/heart-rate/claude/offline-pwa-setup-oFAtx/index.html

---

## Repository Structure

```
heart-rate/
├── index.html      # Single-page app: HTML structure + all embedded CSS
├── script.js       # All application logic (~1,055 lines, 8 modules)
├── sw.js           # Service worker (offline caching, cache-first strategy)
├── manifest.json   # PWA manifest (app name, icon, display mode)
├── icon.svg        # SVG app icon (heart + ECG waveform)
└── README.md       # Brief project description
```

**No build system, no dependencies, no package.json.** Deploy by serving static files directly.

---

## Architecture

All logic lives in `script.js`, organized into 8 modules using object/closure patterns with a shared `AppState` object.

### Module Overview

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `CONSTANTS` | 1–86 | Immutable configuration for signal processing, beat detection, storage limits |
| `Config` | ~87–170 | Persistent user settings (localStorage-backed), defaults and load/save |
| `Camera` | 170–223 | getUserMedia, torch/flashlight, rear camera, stream cleanup |
| `WakeLock` | 228–251 | Screen wake lock acquisition/release |
| `SignalProcessor` | 256–330 | PPG signal extraction, adaptive normalization, simulation generation |
| `BeatDetector` | 335–447 | Real-time and offline beat detection, BPM calculation |
| `Renderer` | 452–524 | Canvas waveform drawing, beat markers, threshold line, time markers |
| `Storage` | 529–604 | localStorage CRUD, quota management, export |
| `UI` + Event Handlers | 609–948 | Tab switching, mode management, animation loop |

### Application Modes

```
idle  →  camera  (tap canvas, real camera)
idle  →  simulate  (Settings: Demo toggle)
camera/simulate  →  idle  (tap canvas again, or auto-stop)
idle  →  review  (tap a history entry)
review  →  idle  (tap canvas or close)
```

Mode transitions are managed by `AppState.mode` and the functions `startCamera()`, `startSimulation()`, `stopRecording()`, `startReview()`.

---

## Key Algorithms

### PPG Signal Processing (`SignalProcessor`)

1. **Frame capture:** Camera frame → 30×30 pixel downsample → average green channel intensity
2. **Saturation detection:** Flags overexposed frames (intensity > 250)
3. **Normalization:** Adaptive gain control over a 120-frame sliding window; exponential smoothing (factor: gain smoothing constant); output clamped to `[-0.6, 0.6]`

### Beat Detection (`BeatDetector`)

- Maintains a **running maximum** with 0.99 decay per sample
- **Dynamic threshold** = 50% of running max (minimum baseline enforced)
- **Refractory period** = 250–1000ms (adapts to detected BPM to reject noise)
- **BPM** = calculated from last N inter-beat intervals (default window: 8 beats), smoothed with factor 0.7
- Offline analysis (`detectBeats()`) used for reviewing saved recordings

### Simulation (`generateSimulation()`)

Generates a synthetic PPG/ECG-like signal using Gaussian waveforms:
- QRS complex (sharp peak)
- P-wave (smaller preceding peak)
- Additive noise for realism

---

## Data Storage

- **API:** `localStorage`
- **Record format:**
  ```json
  {
    "id": "<timestamp>",
    "v": 2,
    "timestamp": 1234567890,
    "duration": 60000,
    "avgBpm": 72,
    "samples": [{ "t": 0, "v": 0.3 }, ...]
  }
  ```
- **Version field (`v`):** Records with wrong version are filtered out on load
- **Max records:** Configurable (`CONSTANTS.MAX_RECORDS`)
- **Max storage:** 5 MB quota; triggers oldest-batch deletion at 95% usage
- **Export:** JSON blob download via `Storage.exportAll()`

---

## Service Worker (`sw.js`)

- **Cache name:** `pulse-v2` (increment version string to force cache refresh)
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
- Use the built-in **Demo mode** (Settings tab → toggle Demo) which runs `generateSimulation()` instead of the camera

### Making Changes

1. Edit `index.html` (HTML structure or CSS) or `script.js` (logic)
2. If you add new cached assets, update the `urlsToCache` array in `sw.js`
3. If the record data format changes, increment `STORAGE_VERSION` in `CONSTANTS` and update the record format documentation above
4. If cache-busting is needed, increment `CACHE_NAME` in `sw.js`

### No Tests

There is no automated test suite. Verify changes manually in browser. Key scenarios to check:
- Camera start/stop (requires physical device or emulation)
- Beat detection accuracy (compare BPM readout against known pulse)
- Recording save/load/delete/export
- Demo (simulation) mode
- Review mode playback with slider
- PWA install and offline behavior

---

## Important Constants (in `CONSTANTS`, `script.js:1-86`)

| Constant | Purpose |
|----------|---------|
| `WARMUP_FRAMES` | Frames to discard on camera start for sensor stabilization |
| `NORM_WINDOW` | Normalization sliding window size (frames) |
| `REFRACTORY_MIN/MAX` | Beat detector lockout range (ms) |
| `BPM_WINDOW` | Number of inter-beat intervals for BPM smoothing |
| `BPM_SMOOTHING` | Exponential smoothing factor for BPM display |
| `MAX_RECORDS` | Maximum saved recordings in localStorage |
| `STORAGE_QUOTA_CRITICAL` | localStorage usage fraction triggering auto-deletion |
| `STORAGE_VERSION` | Record format version; increment on schema changes |

---

## PWA Notes

- The app is installable on Android and iOS (as "Add to Home Screen")
- `manifest.json` declares `display: standalone` and portrait orientation
- Wake Lock keeps screen on during recording (degrades gracefully if unsupported)
- Torch/flashlight is requested via `torch: true` constraint for better signal on dark fingers

---

## Branch Naming

Past branches follow the pattern `claude/<description>-<id>`. New feature branches should follow the same convention.
