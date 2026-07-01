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

---
---

# Second-pass analysis — 2026-07-01

Baseline: all 50 regression tests pass; the signal-processing and beat-detection
core is sound. The first-pass fixes hold. The defects below are what remains,
again concentrated in the mode state machine and the save path. Findings 1–4
were each verified empirically by driving the unmodified `script.js` through
`test/harness.js` (13/13 repro checks confirmed); the low-severity items are
confirmed by code trace.

Status: **all items below are fixed** in the accompanying commit, except the
two perf observations explicitly marked as accepted behavior.

## Medium severity

### 1. `setMode` silently drops transitions requested during a transition; `openReview` assumes its transition happened — Fixed
The `modeTransitioning` guard (first-pass fix for the stream-leak bug) makes an
overlapping `setMode` call a *silent no-op* — it returns immediately without
transitioning and without signalling the caller. Two callers assume the
transition happened:

- **`openReview`** does `await setMode('review')` with a comment saying the
  await exists "so an in-flight camera auto-save reads the live
  BeatDetector.bpm before the replay resets the detector" — but when a
  transition *is* in flight (exactly the case the comment worries about), the
  await resolves instantly against the dropped call. `openReview` then runs
  anyway: it resets the live `BeatDetector` and repopulates it with the
  replayed recording's state (beat timestamps in the replay's 0-based clock
  domain, not the live `performance.now()` domain), installs `reviewData`,
  reprograms the history slider, and overwrites the BPM readout — while
  `AppState.mode` is still `camera` and the review UI never appears. Verified:
  tapping a saved recording while `getUserMedia` is pending (the permission
  prompt can be open for seconds) leaves `mode: 'camera'`, badge `CAMERA`,
  `reviewData` installed, review controls never shown, detector state replaced.
  The same window exists while *leaving* camera mode (the auto-save's
  `checkQuota`/`setItem` awaits), where the replay-corrupted detector keeps
  feeding the still-live camera loop.
- **The `visibilitychange` teardown** (`if (mode === 'camera') setMode('idle')`)
  is likewise dropped if the tab is hidden while the camera transition is still
  in flight — the documented guarantee that hiding the tab auto-saves and
  releases the camera/torch does not hold in that window.

**Fix:** transitions are now serialized on a promise chain — a `setMode` call
that arrives mid-transition runs after the in-flight one completes instead of
being dropped (the target-mode equality check moves inside the queued step, so
a request that has become redundant is still a no-op). The original guarantee
(overlapping transitions can't orphan a half-started stream) is preserved, and
`await setMode(...)` now means the transition really happened. A side effect is
that a stop-tap during camera startup now stops the camera once startup
completes, honoring the user's intent instead of ignoring it.

### 2. Double-tap on Save persists duplicate records — Fixed
`saveRecording` sets `AppState.savedCurrent = true` only *after* awaiting
`Storage.checkQuota()` (a real async API — `navigator.storage.estimate()`) and
`Storage.save()`. A second tap landing in that window passes the
`savedCurrent` guard and saves again; the taps get different `Date.now()` ids,
so `Storage.save`'s replace-by-id path doesn't dedupe them. Verified: two
overlapping `saveRecording()` calls persist 2 records from one capture. The
first-pass `savedCurrent` fix (finding 5) covered the *sequential* duplicate,
not the concurrent one.
**Fix:** a synchronous `savePending` guard at the top of `saveRecording` makes
the overlapping call a no-op. The record (samples, duration, avgBpm) is also
now snapshotted *before* the first await, so a mode change that runs
`clearHistory()` during the quota check can no longer be read back as an
empty capture.

### 3. Mode-entry cleanup only happens in the `idle` branch — stale overlays leak across modes — Fixed
`applyMode` hides `reviewControls`, `saturationWarning` and `torchWarning` only
when entering `idle`. Transitions that skip `idle` keep another mode's UI on
screen:

- **review → simulate** (the Simulate button in Settings is reachable while
  reviewing): the review overlay — timeline scrubber, **Done**, **Save Graph
  Img** — stays overlaid on the live simulation graph, and the scrubber keeps
  writing `AppState.reviewOffset`. Verified.
- **camera → review** and **camera → simulate**: the torch/saturation warning
  banners stay overlaid on the review/simulation view. Verified for the torch
  warning into review; the saturation warning and the simulate destination
  follow the identical code path.

**Fix:** the overlay/warning cleanup is hoisted out of the `idle` branch and
runs on every transition; whatever the new mode needs is re-raised afterwards
(the review branch re-activates its controls, `Camera.start` re-shows the
torch warning).

## Low severity

### 4. Too-short capture with Auto-Save on leaves a dead, silent Save button — Fixed
A capture under `MIN_SAVE_SECONDS` is skipped by auto-save, so `savedCurrent`
stays false and the Save button is shown in idle. Tapping it hits the same
too-short early return, whose alert is gated on `!Config.autoSave` — so with
Auto-Save on the tap does nothing and says nothing. Verified: button visible,
0 records, 0 alerts.
**Fix:** both suggestions applied — the Save button now hides for captures
below `MIN_SAVE_SECONDS`, and `saveRecording` takes a `manual` flag (set by the
Save button) so a user-initiated save always gets feedback while the auto-save
path stays silent.

### 5. Code/doc mismatch: tapping the canvas does not exit review — Fixed
`handleCanvasTap` returned early for `review`, so only **Done** exited — but
the mode diagram in CLAUDE.md documents "review → idle (tap canvas or Done)".
**Fix:** the code now matches the docs — a canvas tap in review exits to idle.
The tap-ignore guard was widened from `button` to
`button, input, #reviewControls, #installBanner`, which also fixes two latent
relatives of first-pass finding 1: dragging the review timeline scrubber (an
`input`, not a `button`) and tapping the install banner's text area no longer
bubble into `handleCanvasTap` (the latter used to start the camera).

### 6. Cosmetics / robustness (code trace) — Fixed except where noted
- **Renderer `lineWidth` leak:** the signal stroke sets `lineWidth = 2` and
  never resets it, so the grid and threshold lines render at 1px on the first
  frame and 2px on every later frame. **Fix:** reset to 1 at the top of
  `drawSignal`.
- **`Camera.getStats` hides ISO 0:** `s.iso || '--'` — same falsy-zero bug the
  first pass fixed for `exposureCompensation`. **Fix:** `??`.
- **`exportGraphImage`:** revoked the object URL synchronously after
  `a.click()` (can abort the download in some browsers), didn't handle
  `toBlob` yielding `null`, and unlike `exportAllData` never appended the
  anchor to the DOM. **Fix:** both exports share a `downloadUrl` helper that
  appends the anchor and revokes on a delay; the `null`-blob case alerts.
- **Dead code:** `AppState.reviewData.duration` was assigned in `openReview`
  but never read. **Fix:** removed.
- **Quadratic work on long recordings:** **Fixed** the per-frame costs —
  `drawSignal` now walks back from the newest visible sample (O(window) per
  frame instead of O(recording)), and `openReview` carries the last known BPM
  forward into each replay point so the scrubber label is a direct read
  instead of a backward scan. **Accepted as-is:** `AppState.recording` growing
  without limit (any cap would silently truncate saves — the exact bug fixed
  in first-pass finding 2) and the FFT replay running one `computeBPM` per
  sample (it mirrors the live path exactly and stays fast at realistic
  recording lengths).
- **Theoretical double-loop window:** if the tab was hidden and re-shown while
  `loop` was suspended at `await setMode('idle')` (auto-stop), the visibility
  handler could start a second rAF chain before the suspended one re-armed.
  **Fix:** a `loopGeneration` token, bumped on cancel, stops a stale suspended
  invocation from re-arming; the visible branch schedules via
  `requestAnimationFrame` so `animationFrameId` is set synchronously.

## Verification

Findings 1–4 were reproduced against the unmodified `script.js` in the
`test/harness.js` Node vm sandbox (fake `getUserMedia`/`navigator.storage` where
needed): 13/13 repro assertions confirmed. The existing 50-check regression
suite was green at that baseline.

With the fixes applied, 7 regression checks were added to `test/run-tests.js`
(queued transitions, overlay cleanup on review→simulate and camera→review,
concurrent-save dedupe, and the too-short-capture Save button): all 7 fail
against the pre-fix `script.js` and the full suite is green at 57 checks on the
fixed one. `CACHE_NAME`/`APP_CACHE` were bumped to `pulse-v12` so installed
PWAs pick up the fixes.
