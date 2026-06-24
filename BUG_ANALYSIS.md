# Bug Analysis — Pulse Monitor

Analysis date: 2026-06-13. Baseline: all 45 regression tests in `test/run-tests.js`
pass; the beat-detection and simulation math is sound. The defects below are in
the mode/state machine, event handling, and storage around that core. Each
behavioral claim was verified by driving the real `script.js` through
`test/harness.js` (a Node `vm` sandbox), except finding 1 which is confirmed by
code trace plus the git history of an earlier partial fix (commit `f457343`).

Status column reflects this branch (`claude/busy-pascal-tbeo2w`): **Fixed** items
are addressed in the accompanying commit; **Open** items are left as follow-ups.

---

## High severity

### 1. Every button inside the canvas area also toggles recording — Fixed
`script.js` canvas tap handlers. Commit `f457343` added a `closest('button')`
guard to the `touchstart` listener but not to the sibling `click` listener.
Button clicks bubble to `#canvasContainer`, so tapping **Done** in review runs
`setMode('idle')` and then the bubbled click calls `handleCanvasTap`, which sees
`idle` and starts the camera — review exits straight into a live camera session.
The same applies to **Save** (saves, then starts the camera) and the install
banner's **Install / ✕** buttons (dismissing triggers a camera permission
prompt). Desktop and mobile both affected.
**Fix:** add the same `closest('button')` guard to the `click` listener.

### 2. Recordings are silently truncated to the last 20 seconds — Fixed
`AppState.addHistoryPoint` trims its buffer to `DISPLAY.HISTORY_SECONDS` (20 s)
for rendering, but `saveRecording` used that same buffer as the recording
source. A 45 s recording saved `duration: 45.0` while its samples spanned only
`t = 25 s → 45 s`; the first 25 s were lost, and review could never replay more
than 20 s.
**Fix:** keep a separate full-resolution `AppState.recording` buffer (never
trimmed) and save from it; `history` remains the windowed display buffer.

### 3. Double-tap during camera startup leaks a live stream (torch stays on) — Fixed
`setMode` had no re-entrancy guard and set `AppState.mode = newMode` *before*
`await Camera.start()`. A second tap while `getUserMedia` was pending ran
`setMode('idle')` against a still-null stream (no-op `Camera.stop`), then the
first call resumed and assigned the stream with the torch on while the UI read
`idle`. The next start overwrote `Camera.stream`, orphaning the first stream
forever. Verified: `mode: 'idle'`, `streamLive: true`, `0 tracks stopped`.
**Fix:** a `modeTransitioning` lock makes overlapping transitions no-ops.

---

## Medium severity

### 4. "Never save simulation data" guard is bypassable; camera→review loses data — Fixed
The discard/auto-save guards were keyed on the exact `*→idle` transition, so
`simulate → review → idle` (tapping a history entry while simulating) preserved
the synthetic history and let it be saved as a real recording (verified: 301
simulated samples persisted). Conversely `camera → review` skipped the auto-save
and discarded a live recording even with Auto-Save on, and `openReview` reset and
replayed `BeatDetector` so a later save stamped the *reviewed* recording's BPM as
the new record's `avgBpm`.
**Fix:** handle auto-save/discard by the mode being *left* (any transition out of
`camera` auto-saves; any transition out of `simulate` discards), and make
`openReview` await `setMode` so the in-flight auto-save reads the live BPM before
the replay resets the detector.

### 5. Auto-save leaves the Save button active → one-tap duplicate records — Fixed
After `camera → idle` with Auto-Save on, history was not cleared so `canSave`
stayed true; pressing the still-visible Save created a second record with
identical samples (verified). Combined with finding 1 the same press also started
the camera.
**Fix:** a `savedCurrent` flag (reset when a new capture starts) hides the Save
button once the capture has been persisted and blocks a redundant save.

### 6. Stopping via tab-switch bypasses auto-save entirely — Fixed
The `visibilitychange` handler set `AppState.mode = 'idle'` directly instead of
going through `setMode`, so the auto-save branch never ran — a recording
interrupted by hiding the tab was lost even with Auto-Save on (verified: 0 records
saved), exactly the case auto-save exists for.
**Fix:** route the hide path through `setMode('idle')`.

### 7. Storage quota guard can't fire; a real quota error loses the recording silently — Fixed
`Storage.checkQuota` read `navigator.storage.estimate()`, which measures the
origin-wide quota (hundreds of MB+), while `localStorage` has its own independent
~5 MB cap. The 95% check essentially never tripped before `localStorage.setItem`
threw `QuotaExceededError`, which nothing caught (async `saveRecording` → silent
unhandled rejection): the recording vanished with no alert.
**Fix:** wrap the write in try/catch, evict oldest records until it fits, and
alert + return `false` if even one record won't fit; `saveRecording` honors the
result.

### 8. Two animation-loop chains can run concurrently — Fixed
The visible branch of `visibilitychange` called `loop()` unconditionally. A loop
queued before the tab was hidden (or while `loop` was suspended at
`await setMode('idle')`) is merely paused by the browser; on focus it fires *and*
the handler starts a second chain, doubling every camera/simulation frame.
**Fix:** track the rAF id (null it on cancel) and only restart the loop when one
isn't already queued.

---

## Low severity — Fixed

- **BPM window of 1 bricked the BPM display.** A typed `1` passed validation
  (`parseInt(...) || 8` only rejects `0`/NaN), capping `detectedBeats` at one
  entry so the `>= 2` branch never ran (BPM stuck at 0).
  **Fix:** `saveSettings` clamps the window to `[2, 50]`, and `BeatDetector.process`
  clamps `bpmWindow` to `>= 2` defensively so a stale persisted `1` can't brick it.
- **FFT mode showed junk BPM with no signal.** `computeBPM` had no peak floor: a
  flat buffer returned 35 BPM and pure noise 186, shown before a finger touched
  the lens; review also replayed only the threshold detector.
  **Fix:** a peak-to-mean ratio gate (`FFT.MIN_PEAK_RATIO`, measured >9 for real
  signals vs <2 for noise) returns 0 when no real pulse is present, and the review
  replay now mirrors the live `displayBpm` (FFT estimate when active).
- **Typing in any settings number field reset the beat detector mid-recording**
  via `oninput → saveSettings → BeatDetector.reset()`.
  **Fix:** removed the reset from `saveSettings`; a window change is absorbed by
  `BeatDetector.process` and no other setting needs it.
- **`avgBpm` was not an average** — it stored the final smoothed BPM but the list
  labels it "Avg BPM".
  **Fix:** compute a true mean of the per-frame BPM across the capture.
- **"Minimum 1 second" was wrong.** `MIN_SAVE_LENGTH: 60` counted frames (2 s at
  30 fps, 4 s at 15 fps).
  **Fix:** the threshold is now time-based (`MIN_SAVE_SECONDS`, compared against
  `totalTime`).
- **Cosmetics.** **Fix:** negative time-axis labels are skipped before `t = 0`;
  `getStats` uses `??` so `exposureCompensation: 0` is shown; the mandatory
  `frameRate: { min: 30 }` constraint was relaxed to `{ ideal: 60 }` so
  `getUserMedia` doesn't fail on cameras that won't guarantee 30 fps.

One deeper item is intentionally **not** changed: with FFT mode off, `avgBpm` and
the live readout still come from the threshold detector — the FFT path remains an
opt-in Settings toggle.

---

## Verification

Findings 2–8 and the low-severity items were reproduced empirically against the
unmodified `script.js` via the test harness; finding 1 is confirmed by code trace
and the history of commit `f457343`. Regression tests were added to
`test/run-tests.js` for finding 2 (recording buffer retains the full capture),
the FFT signal-quality gate (flat/noise report no BPM), and the BPM-window clamp;
the suite is green at 50 checks.
