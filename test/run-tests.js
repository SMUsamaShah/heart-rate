#!/usr/bin/env node
// Headless regression suite for the PPG beat detector and demo-mode
// simulation. It loads the real script.js (unmodified) through test/harness.js
// and feeds synthetic PPG signals through the exact code paths the browser
// uses: SignalProcessor.normalize -> BeatDetector.process (and the
// BandpassFilter/FFTAnalyzer path).
//
// Usage:
//   node test/run-tests.js                 # test ./script.js
//   node test/run-tests.js path/to/old.js  # test another version, e.g.
//                                          #   git show HEAD:script.js > /tmp/old.js
'use strict';

const path = require('path');
const vm = require('vm');
const { loadApp, seededRandom } = require('./harness');

const SCRIPT = process.argv[2] || path.join(__dirname, '..', 'script.js');

// ----------------------------------------------------------------------------
// Synthetic PPG generator (test-side, independent of the app's simulation)
// ----------------------------------------------------------------------------
// bpmAt(t) lets a scenario describe steady rates, sudden jumps and ramps.
function makePpg({ bpmAt, fps, durationS, noise = 0.05, dicroticAmp = 0.3,
                   hrvJitter = 0.02, qrsWidth = 0.09, seed = 99 }) {
    const rng = seededRandom(seed);
    const samples = [];
    const dt = 1 / fps;
    let beatPhase = 0;
    let beatDuration = 0;
    let amp = 1;

    for (let t = 0; t < durationS; t += dt) {
        if (beatDuration <= 0) beatDuration = 60 / bpmAt(t);
        beatPhase += dt;
        while (beatPhase >= beatDuration) {
            beatPhase -= beatDuration;
            beatDuration = (60 / bpmAt(t)) * (1 + (rng() * 2 - 1) * hrvJitter);
            amp = 1 + (rng() * 2 - 1) * 0.1;
        }

        const ph = beatPhase / beatDuration;
        const g = (a, c, w) => a * Math.exp(-((ph - c) ** 2) / (2 * w * w));
        let v = amp * g(1.0, 0.2, qrsWidth);
        if (dicroticAmp > 0) v += amp * g(dicroticAmp, 0.35, 0.12);
        v += (rng() * 2 - 1) * noise;

        samples.push({ t, v });
    }
    return samples;
}

// Live-loop equivalent: normalize each raw sample, then run beat detection.
function runDetector(app, samples, bpmWindow = 8) {
    app.SignalProcessor.reset();
    app.BeatDetector.reset();
    const scale = app.CONSTANTS.SIMULATION.SIGNAL_SCALE;
    return samples.map(s => {
        const normalized = app.SignalProcessor.normalize(s.v * scale);
        const r = app.BeatDetector.process(normalized, s.t * 1000, bpmWindow);
        return { t: s.t, bpm: r.bpm, isBeat: r.isBeat };
    });
}

// Demo-mode equivalent: drive the app's own simulation through the detector.
function runSimulation(app, targetBpm, fps, durationS) {
    app.SignalProcessor.reset();
    app.BeatDetector.reset();
    const dt = 1 / fps;
    const out = [];
    for (let t = 0; t < durationS; t += dt) {
        const sig = app.SignalProcessor.generateSimulation(dt, targetBpm);
        const r = app.BeatDetector.process(sig, t * 1000, app.Config.bpmCalculationWindow);
        out.push({ t, bpm: r.bpm, sig });
    }
    return out;
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------
function tailMeanBpm(results, lastSeconds) {
    const tEnd = results[results.length - 1].t;
    const vals = results.filter(r => r.t >= tEnd - lastSeconds && r.bpm > 0);
    if (!vals.length) return 0;
    return vals.reduce((a, r) => a + r.bpm, 0) / vals.length;
}

// First time the displayed BPM enters and stays within tolFrac of target for
// at least holdS seconds. Infinity if it never settles.
function settleTime(results, target, tolFrac, fromT = 0, holdS = 3) {
    let windowStart = null;
    for (const r of results) {
        if (r.t < fromT) continue;
        const ok = r.bpm > 0 && Math.abs(r.bpm - target) / target <= tolFrac;
        if (ok) {
            if (windowStart === null) windowStart = r.t;
            if (r.t - windowStart >= holdS) return windowStart;
        } else {
            windowStart = null;
        }
    }
    return Infinity;
}

// ----------------------------------------------------------------------------
// Tiny test framework
// ----------------------------------------------------------------------------
let passed = 0, failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function checkBpm(name, actual, target, tolFrac) {
    const tol = Math.max(tolFrac, 3 / target); // never tighter than ±3 BPM
    check(name, actual > 0 && Math.abs(actual - target) / target <= tol,
        `expected ${target}±${(target * tol).toFixed(1)}, got ${actual.toFixed(1)}`);
}

function section(title) {
    console.log(`\n${title}`);
}

// ----------------------------------------------------------------------------
// Scenarios
// ----------------------------------------------------------------------------
const probe = loadApp(SCRIPT);
// The rewritten simulation takes (dt, targetBpm); the old one took
// (phase, bpm, totalTime). Sim-specific tests only make sense on the new one.
const hasNewSim = probe.SignalProcessor.generateSimulation.length <= 2;
console.log(`Testing: ${SCRIPT}`);
console.log(`Simulation API: ${hasNewSim ? 'current (dt, targetBpm)' : 'legacy — skipping simulation tests'}`);

section('Detector invariants');
{
    const f = probe.CONSTANTS.BEAT_DETECTION.REFRACTORY_FACTOR;
    check('REFRACTORY_FACTOR < 0.5 (half-rate lock must be self-correcting)',
        f < 0.5, `got ${f}`);
}

section('Steady-rate accuracy (clean-ish signal, 45s)');
for (const fps of [30, 60]) {
    for (const bpm of [50, 75, 100, 140, 180, 200, 220, 240]) {
        const app = loadApp(SCRIPT, 100 + bpm + fps);
        const samples = makePpg({ bpmAt: () => bpm, fps, durationS: 45, seed: bpm * fps });
        const res = runDetector(app, samples);
        checkBpm(`${bpm} BPM @ ${fps}fps`, tailMeanBpm(res, 10), bpm, 0.04);
    }
}

section('Low frame rate (torch mode often drops the camera to ~15fps)');
for (const bpm of [60, 120, 180, 200]) {
    const app = loadApp(SCRIPT, 300 + bpm);
    const samples = makePpg({ bpmAt: () => bpm, fps: 15, durationS: 45, seed: bpm * 15 });
    const res = runDetector(app, samples);
    checkBpm(`${bpm} BPM @ 15fps`, tailMeanBpm(res, 10), bpm, 0.08);
}

section('REGRESSION: sudden rise 70 -> 200 BPM (reported field failure)');
for (const fps of [30, 60]) {
    const app = loadApp(SCRIPT, 400 + fps);
    const samples = makePpg({
        bpmAt: t => (t < 15 ? 70 : 200),
        fps, durationS: 60, seed: 42 * fps
    });
    const res = runDetector(app, samples);
    const preJump = res.filter(r => r.t < 15);
    checkBpm(`settles at 70 before the jump @ ${fps}fps`,
        tailMeanBpm(preJump, 5), 70, 0.05);

    const settle = settleTime(res, 200, 0.05, 15);
    check(`recovers to 200 within 20s of the jump @ ${fps}fps`,
        settle - 15 <= 20,
        settle === Infinity
            ? `never settles — stuck near ${tailMeanBpm(res, 10).toFixed(0)} BPM (half-rate lock)`
            : `took ${(settle - 15).toFixed(1)}s`);
    checkBpm(`steady at 200 at the end @ ${fps}fps`, tailMeanBpm(res, 10), 200, 0.05);
}

section('Gradual ramp 60 -> 200 over 45s');
{
    const app = loadApp(SCRIPT, 500);
    const samples = makePpg({
        bpmAt: t => (t < 45 ? 60 + (140 * t) / 45 : 200),
        fps: 30, durationS: 60, seed: 77
    });
    const res = runDetector(app, samples);
    checkBpm('tracks the ramp to 200', tailMeanBpm(res, 10), 200, 0.05);
}

section('Sudden drop 180 -> 60 BPM');
{
    const app = loadApp(SCRIPT, 600);
    const samples = makePpg({
        bpmAt: t => (t < 15 ? 180 : 60),
        fps: 30, durationS: 60, seed: 88
    });
    const res = runDetector(app, samples);
    const settle = settleTime(res, 60, 0.05, 15);
    check('recovers to 60 within 20s of the drop',
        settle - 15 <= 20,
        settle === Infinity ? `never settles, tail ${tailMeanBpm(res, 10).toFixed(0)}` : `took ${(settle - 15).toFixed(1)}s`);
    checkBpm('steady at 60 at the end', tailMeanBpm(res, 10), 60, 0.05);
}

section('Noise robustness at 200 BPM (heavy sensor noise)');
{
    const app = loadApp(SCRIPT, 700);
    const samples = makePpg({ bpmAt: () => 200, fps: 30, durationS: 45, noise: 0.15, seed: 13 });
    const res = runDetector(app, samples);
    const tail = tailMeanBpm(res, 10);
    checkBpm('reads ~200 despite noise', tail, 200, 0.08);
    check('not locked at half rate', tail > 150, `tail ${tail.toFixed(0)}`);
}

section('Dicrotic-notch rejection (strong secondary wave, no double-count)');
for (const bpm of [60, 90]) {
    const app = loadApp(SCRIPT, 800 + bpm);
    const samples = makePpg({ bpmAt: () => bpm, fps: 30, durationS: 45, dicroticAmp: 0.45, noise: 0.03, seed: bpm });
    const res = runDetector(app, samples);
    checkBpm(`${bpm} BPM with 45%-amplitude notch`, tailMeanBpm(res, 10), bpm, 0.05);
}

if (hasNewSim) {
    section('Demo mode: detector must read back the slider value (50s each)');
    for (const target of [60, 75, 120, 180, 200, 220]) {
        const app = loadApp(SCRIPT, 900 + target);
        const res = runSimulation(app, target, 30, 50);
        checkBpm(`simulated ${target} BPM`, tailMeanBpm(res, 10), target, 0.06);
    }

    section('Simulation realism');
    {
        const a = loadApp(SCRIPT, 1001);
        const b = loadApp(SCRIPT, 1002);
        const c = loadApp(SCRIPT, 1001);
        const run = app => {
            app.SignalProcessor.reset();
            const out = [];
            for (let i = 0; i < 600; i++) out.push(app.SignalProcessor.generateSimulation(1 / 30, 75));
            return out;
        };
        const sa = run(a), sb = run(b), sc = run(c);
        const maxDiff = (x, y) => Math.max(...x.map((v, i) => Math.abs(v - y[i])));
        check('noise is random (different seeds -> different waveforms)',
            maxDiff(sa, sb) > 1e-3, `max diff ${maxDiff(sa, sb)}`);
        check('but reproducible (same seed -> identical waveform)',
            maxDiff(sa, sc) === 0, `max diff ${maxDiff(sa, sc)}`);

        // High-frequency noise floor: a noiseless gaussian train at 30fps is
        // smooth; white noise shows up as sample-to-sample jitter.
        const meanAbsDiff = sa.slice(1).reduce((acc, v, i) => acc + Math.abs(v - sa[i]), 0) / (sa.length - 1);
        check('white noise present in the waveform', meanAbsDiff > 0.002,
            `mean |x[n]-x[n-1]| = ${meanAbsDiff.toFixed(5)}`);
    }
    {
        // Heart-rate variability: per-beat durations must vary, a few percent.
        const app = loadApp(SCRIPT, 1100);
        app.SignalProcessor.reset();
        const durations = new Set();
        for (let i = 0; i < 30 * 30; i++) {
            app.SignalProcessor.generateSimulation(1 / 30, 75);
            durations.add(app.SignalProcessor.simState.beatDuration);
        }
        const d = [...durations];
        const mean = d.reduce((a, v) => a + v, 0) / d.length;
        const sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / d.length);
        check('beat-to-beat interval jitter (HRV) present',
            d.length > 10 && sd / mean > 0.005 && sd / mean < 0.1,
            `${d.length} distinct durations, cv=${(sd / mean).toFixed(4)}`);
    }
}

section('Recording buffer keeps the full capture (not just the display window)');
{
    // Regression for the "recordings truncated to the last 20s" bug: the
    // display buffer (history) is windowed, but the recording buffer that
    // saveRecording() reads from must retain every sample.
    const app = loadApp(SCRIPT);
    app.AppState.clearHistory();
    const fps = 30, durationS = 45;
    for (let i = 0; i <= fps * durationS; i++) {
        const t = i / fps;
        app.AppState.totalTime = t;
        app.AppState.addHistoryPoint(t, 0.1, 0.05, false, 70);
    }
    const hist = app.AppState.history;
    const rec = app.AppState.recording;
    const histSpan = hist[hist.length - 1].time - hist[0].time;
    check('display buffer is windowed to ~HISTORY_SECONDS',
        histSpan <= app.CONSTANTS.DISPLAY.HISTORY_SECONDS + 1,
        `display span ${histSpan.toFixed(1)}s`);
    // Older versions lacked a separate recording buffer (the truncation bug);
    // fail cleanly rather than crashing when run against them.
    if (!Array.isArray(rec)) {
        check('recording buffer retains the full duration from t=0', false,
            'AppState.recording buffer is missing — saves are truncated to the display window');
    } else {
        const recSpan = rec[rec.length - 1].time - rec[0].time;
        check('recording buffer retains the full duration from t=0',
            rec[0].time === 0 && recSpan >= durationS - 1,
            `recording span ${recSpan.toFixed(1)}s from t=${rec[0].time}`);
    }
}

section('FFT mode at 200 BPM');
{
    const app = loadApp(SCRIPT, 1200);
    app.SignalProcessor.reset();
    app.BandpassFilter.reset();
    app.FFTAnalyzer.reset();
    const samples = makePpg({ bpmAt: () => 200, fps: 30, durationS: 40, seed: 55 });
    const scale = app.CONSTANTS.SIMULATION.SIGNAL_SCALE;
    let prevT = null;
    for (const s of samples) {
        const normalized = app.SignalProcessor.normalize(s.v * scale);
        const dt = prevT === null ? 1 / 30 : s.t - prevT;
        prevT = s.t;
        const filtered = app.BandpassFilter.process(normalized, dt);
        app.FFTAnalyzer.addSample(filtered, s.t * 1000);
    }
    const fftBpm = app.FFTAnalyzer.computeBPM();
    check('FFT estimate within ±10 BPM of 200', Math.abs(fftBpm - 200) <= 10, `got ${fftBpm}`);
}

section('FFT signal-quality gate (no phantom BPM without a real pulse)');
{
    const app = loadApp(SCRIPT, 1300);
    const N = app.CONSTANTS.FFT.BUFFER_SIZE;

    app.FFTAnalyzer.reset();
    for (let i = 0; i < N; i++) app.FFTAnalyzer.addSample(0, i * 33.3);
    check('flat no-finger frame reports no BPM', app.FFTAnalyzer.computeBPM() === 0,
        `got ${app.FFTAnalyzer.computeBPM()}`);

    app.FFTAnalyzer.reset();
    const rng = seededRandom(31);
    for (let i = 0; i < N; i++) app.FFTAnalyzer.addSample((rng() - 0.5) * 0.02, i * 33.3);
    check('pure sensor noise reports no BPM', app.FFTAnalyzer.computeBPM() === 0,
        `got ${app.FFTAnalyzer.computeBPM()}`);
}

section('BPM window < 2 is clamped, not bricked');
{
    const app = loadApp(SCRIPT, 1400);
    const samples = makePpg({ bpmAt: () => 75, fps: 30, durationS: 30, seed: 75 });
    const res = runDetector(app, samples, 1); // pathological window from a stale setting
    checkBpm('reads ~75 BPM even with window=1', tailMeanBpm(res, 10), 75, 0.06);
}

// ----------------------------------------------------------------------------
// Mode/state-machine regressions — driven through the real setMode /
// openReview / saveRecording globals inside the sandbox, with getUserMedia
// and navigator.storage faked where the scenario needs them.
// ----------------------------------------------------------------------------
function fakeCameraStream() {
    const track = {
        getCapabilities: () => ({}), // no torch support
        getSettings: () => ({ width: 320, height: 240, frameRate: 30 }),
        applyConstraints: async () => {},
        stop: () => {}
    };
    return { getVideoTracks: () => [track], getTracks: () => [track] };
}

// A minimal valid stored recording: 5s of a pulse-like waveform at ~75 BPM.
function makeStoredRecording(app, id = 1) {
    const samples = [];
    for (let t = 0; t < 5; t += 1 / 30) {
        const ph = (t % 0.8) / 0.8;
        samples.push({ t, v: 0.5 * Math.exp(-((ph - 0.2) ** 2) / (2 * 0.08 ** 2)) });
    }
    return { id, v: app.CONSTANTS.VERSION, timestamp: new Date().toISOString(),
             duration: 5, avgBpm: 75, samples };
}

const domEl = (app, id) => app.context.document.getElementById(id);

(async () => {
    section('Transitions requested mid-transition are queued, not dropped');
    try {
        const app = loadApp(SCRIPT, 2000);
        const ctx = app.context;
        let resolveGUM;
        ctx.navigator.mediaDevices = {
            getUserMedia: () => new Promise(r => { resolveGUM = r; })
        };
        const camP = ctx.setMode('camera');                      // suspends in getUserMedia
        const revP = ctx.openReview(makeStoredRecording(app));   // arrives mid-transition
        // Let the (possibly queued) camera transition reach getUserMedia,
        // then answer the "permission prompt".
        for (let i = 0; !resolveGUM && i < 100; i++) await new Promise(r => setImmediate(r));
        resolveGUM(fakeCameraStream());
        await camP;
        await revP;
        check('openReview during camera startup still reaches review mode',
            app.AppState.mode === 'review', `mode=${app.AppState.mode}`);
        check('review UI is shown',
            domEl(app, 'reviewControls').classList.contains('active'));
    } catch (e) {
        check('openReview during camera startup still reaches review mode', false, e.message);
    }

    section('Mode-owned overlays are cleared on every transition');
    try {
        const app = loadApp(SCRIPT, 2100);
        await app.context.openReview(makeStoredRecording(app));
        await app.context.setMode('simulate'); // Simulate button is reachable from review
        check('review -> simulate hides the review controls',
            app.AppState.mode === 'simulate' &&
            !domEl(app, 'reviewControls').classList.contains('active'));
    } catch (e) {
        check('review -> simulate hides the review controls', false, e.message);
    }
    try {
        const app = loadApp(SCRIPT, 2200);
        const ctx = app.context;
        ctx.navigator.mediaDevices = { getUserMedia: async () => fakeCameraStream() };
        await ctx.setMode('camera'); // torchless stream raises the torch warning
        const shownDuringCamera = !domEl(app, 'torchWarning').classList.contains('hidden');
        await ctx.openReview(makeStoredRecording(app));
        check('camera -> review hides the torch warning',
            shownDuringCamera && domEl(app, 'torchWarning').classList.contains('hidden'),
            shownDuringCamera ? 'warning leaked into review' : 'warning never shown in camera');
    } catch (e) {
        check('camera -> review hides the torch warning', false, e.message);
    }

    section('Concurrent Save taps persist a single record');
    try {
        const app = loadApp(SCRIPT, 2300);
        const ctx = app.context;
        // navigator.storage.estimate() is genuinely async in browsers — that
        // gap is what let a second tap through before savedCurrent was set.
        ctx.navigator.storage = { estimate: async () => ({ usage: 0, quota: 1e9 }) };
        // Make sure two saves would get distinct record ids.
        vm.runInContext('(() => { let t = 1e12; Date.now = () => (t += 137); })()', ctx);
        app.AppState.totalTime = 5;
        for (let t = 0; t < 5; t += 1 / 30) app.AppState.addHistoryPoint(t, 0.3, 0.1, false, 75);
        await Promise.all([ctx.saveRecording(true), ctx.saveRecording(true)]);
        const records = JSON.parse(ctx.localStorage.getItem(app.CONSTANTS.STORAGE.KEY) || '[]');
        check('double-tap on Save stores one record', records.length === 1,
            `stored ${records.length}`);
    } catch (e) {
        check('double-tap on Save stores one record', false, e.message);
    }

    section('Too-short capture cannot leave a dead Save button');
    try {
        const app = loadApp(SCRIPT, 2400);
        const ctx = app.context;
        let alerts = 0;
        ctx.alert = () => { alerts++; };
        app.Config.autoSave = true;
        app.AppState.totalTime = 0.5; // < MIN_SAVE_SECONDS
        app.AppState.addHistoryPoint(0.1, 0.3, 0.1, false, 75);
        vm.runInContext('UI.updateButtonsForMode("idle")', ctx);
        check('Save button hidden for a sub-minimum capture',
            domEl(app, 'saveBtn').classList.contains('hidden'));
        await ctx.saveRecording(true);
        check('a manual save attempt still gets feedback', alerts === 1, `${alerts} alerts`);
    } catch (e) {
        check('Save button hidden for a sub-minimum capture', false, e.message);
    }

    // ------------------------------------------------------------------------
    console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
