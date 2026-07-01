// ============================================================================
// CONSTANTS & CONFIG
// ============================================================================
const CONSTANTS = {
    VERSION: 4,
    
    SIGNAL: {
        WARMUP_FRAMES: 30,
        NORMALIZATION_WINDOW: 120,
        GAIN_SMOOTHING: 0.95,
        TARGET_GAIN_RANGE: 0.7,
        SIGNAL_CLAMP_MIN: -0.6,
        SIGNAL_CLAMP_MAX: 0.6,
        SATURATION_THRESHOLD: 250
    },
    
    BEAT_DETECTION: {
        MIN_AMPLITUDE: 0.15,
        // Running-max decay per second (equivalent to the old 0.99/frame at
        // 30fps). Applied time-based so the threshold behaves identically at
        // 15, 30 or 60fps.
        DECAY_PER_SECOND: 0.74,
        THRESHOLD_MULTIPLIER: 0.45,
        BASE_THRESHOLD: 0.05,
        REFRACTORY_PERIOD_MS: 250,
        REFRACTORY_MIN_MS: 200,
        REFRACTORY_MAX_MS: 1000,
        // Fraction of the current beat interval used as the refractory period.
        // MUST stay below 0.5: when the heart rate doubles faster than the
        // displayed BPM tracks it (e.g. 75 -> 200), every other beat lands
        // inside the refractory window and the detector locks onto half the
        // real rate. With factor f, that lock keeps refractory = f * 2 *
        // trueInterval, so only f < 0.5 lets the true rate break back in.
        REFRACTORY_FACTOR: 0.45
    },
    
    BPM: {
        DEFAULT_WINDOW: 8,
        SMOOTHING: 0.7,
        MS_PER_MINUTE: 60000
    },
    
    SIMULATION: {
        DEFAULT_BPM: 75,
        GAUSSIAN_QRS: { amplitude: 1.0, center: 0.2, width: 0.08 },
        // Secondary (dicrotic-like) wave, centered inside the refractory
        // window (center < REFRACTORY_FACTOR) like a real PPG notch — also
        // exercises the detector's double-count rejection.
        GAUSSIAN_DICROTIC: { amplitude: 0.3, center: 0.35, width: 0.12 },
        SIGNAL_SCALE: 0.05,
        // Real-world imperfections, as fractions of the QRS amplitude:
        HRV_JITTER: 0.04,             // per-beat interval variation (±4%)
        AMPLITUDE_JITTER: 0.15,       // per-beat amplitude variation (±15%)
        NOISE_AMPLITUDE: 0.05,        // white sensor noise
        BASELINE_WANDER_AMPLITUDE: 0.2, // slow respiratory-like drift
        BASELINE_WANDER_HZ: 0.25,     // ~15 breaths/min
        ARTIFACTS_PER_SECOND: 0.05,   // rare motion-artifact spikes
        ARTIFACT_AMPLITUDE: 1.2
    },
    
    STORAGE: {
        KEY: 'hr_records',
        SETTINGS_KEY: 'pulse_settings',
        QUOTA_CRITICAL: 0.95,
        MIN_SAVE_SECONDS: 1,
        DELETE_BATCH_SIZE: 10,
        MAX_STORAGE_MB: 5
    },
    
    CAMERA: {
        PREVIEW_SIZE: 30
    },

    FILTER: {
        HP_CUTOFF_HZ: 0.5,
        LP_CUTOFF_HZ: 4.0
    },

    FFT: {
        BUFFER_SIZE: 256,
        MIN_BPM: 30,
        MAX_BPM: 240,
        // Minimum spectral peak-to-mean ratio for the FFT estimate to be
        // trusted. Finger-on signals measure >9; noise / no-finger frames <2.
        MIN_PEAK_RATIO: 4
    },

    DISPLAY: {
        WINDOW_SECONDS: 10,
        HISTORY_SECONDS: 20
    }
};

// Must match CACHE_NAME in sw.js — used for the version display in Settings.
const APP_CACHE = 'pulse-v12';

const Config = {
    showPreview: true,
    autoStopSeconds: 0,
    autoSave: true,
    useFFT: false,
    bpmCalculationWindow: CONSTANTS.BPM.DEFAULT_WINDOW,
    maxRecords: 50,
    
    load() {
        const saved = localStorage.getItem(CONSTANTS.STORAGE.SETTINGS_KEY);
        if (saved) {
            try {
                Object.assign(this, JSON.parse(saved));
            } catch(e) {
                console.error('Failed to load settings', e);
            }
        }
    },
    
    save() {
        const data = {
            showPreview: this.showPreview,
            autoStopSeconds: this.autoStopSeconds,
            bpmCalculationWindow: this.bpmCalculationWindow,
            autoSave: this.autoSave,
            useFFT: this.useFFT,
            maxRecords: this.maxRecords
        };
        localStorage.setItem(CONSTANTS.STORAGE.SETTINGS_KEY, JSON.stringify(data));
    }
};

const DOM = {
    video: document.getElementById('videoElement'),
    ppgCanvas: document.getElementById('ppgCanvas'),
    previewCanvas: document.getElementById('previewCanvas'),
    bpmDisplay: document.getElementById('bpmDisplay'),
    modeBadge: document.getElementById('modeBadge'),
    saturationWarning: document.getElementById('saturationWarning'),
    torchWarning: document.getElementById('torchWarning'),
    instructionOverlay: document.getElementById('instructionOverlay'),
    reviewControls: document.getElementById('reviewControls'),
    reviewTimeDisplay: document.getElementById('reviewTimeDisplay'),
    historySlider: document.getElementById('historySlider'),
    
    tabHistory: document.getElementById('tabHistory'),
    tabSettings: document.getElementById('tabSettings'),
    contentHistory: document.getElementById('contentHistory'),
    contentSettings: document.getElementById('contentSettings'),

    simulateBtn: document.getElementById('simulateBtn'),
    saveBtn: document.getElementById('saveBtn'),
    backToLiveBtn: document.getElementById('backToLiveBtn'),
    exportImgBtn: document.getElementById('exportImgBtn'),
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    deleteOldestBtn: document.getElementById('deleteOldestBtn'),
    
    bpmSlider: document.getElementById('bpmSlider'),
    targetBpmValue: document.getElementById('targetBpmValue'),
    savedList: document.getElementById('savedList'),
    
    settingPreview: document.getElementById('settingPreview'),
    settingAutoStop: document.getElementById('settingAutoStop'),
    settingAutoSave: document.getElementById('settingAutoSave'),
    settingUseFFT: document.getElementById('settingUseFFT'),
    settingBpmWindow: document.getElementById('settingBpmWindow'),
    settingMaxRecords: document.getElementById('settingMaxRecords'),
    
    statRes: document.getElementById('statRes'),
    statFps: document.getElementById('statFps'),
    statExp: document.getElementById('statExp'),
    statIso: document.getElementById('statIso'),
    
    storageInfo: document.getElementById('storageInfo'),
    storageBar: document.getElementById('storageBar'),
    recordCount: document.getElementById('recordCount'),
    emptyState: document.getElementById('emptyState')
};

const ppgCtx = DOM.ppgCanvas.getContext('2d', { alpha: false });
const previewCtx = DOM.previewCanvas.getContext('2d', { willReadFrequently: true });

let animationFrameId = null;
// Bumped whenever the running loop chain is cancelled. A loop invocation that
// was suspended at an await (e.g. auto-stop's setMode) when the cancel
// happened sees the mismatch on resume and does not re-arm, so a chain
// restarted by visibilitychange can never end up doubled.
let loopGeneration = 0;

// ============================================================================
// APP STATE
// ============================================================================
const AppState = {
    mode: 'idle',
    totalTime: 0,
    lastTime: null,
    simBpm: CONSTANTS.SIMULATION.DEFAULT_BPM,
    history: [],          // trimmed display buffer (last HISTORY_SECONDS only)
    recording: [],        // full-resolution capture buffer — what gets saved
    savedCurrent: false,  // true once the current capture has been persisted
    reviewData: null,
    reviewOffset: 0,

    addHistoryPoint(time, val, threshold, isBeat, bpm) {
        // One shared point object goes into both buffers: the display buffer is
        // trimmed to a sliding window, but the recording buffer keeps every
        // sample so saved recordings aren't silently truncated to what's on
        // screen.
        const point = { time, val, threshold, beat: isBeat, bpm };
        this.history.push(point);
        const cutoff = time - CONSTANTS.DISPLAY.HISTORY_SECONDS;
        while (this.history.length > 1 && this.history[0].time < cutoff) {
            this.history.shift();
        }
        this.recording.push(point);
    },

    clearHistory() {
        this.history = [];
        this.recording = [];
        this.savedCurrent = false;
        this.totalTime = 0;
        this.lastTime = null;
    }
};

// ============================================================================
// CAMERA MODULE
// ============================================================================
const Camera = {
    stream: null,
    torchSupported: false,
    
    async start() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 320 },
                    height: { ideal: 240 },
                    frameRate: { ideal: 60 }
                }
            });
            
            DOM.video.srcObject = this.stream;
            await DOM.video.play();
            
            const track = this.stream.getVideoTracks()[0];
            const capabilities = track.getCapabilities?.() || {};
            this.torchSupported = capabilities.torch === true;
            
            if (this.torchSupported) {
                await track.applyConstraints({ advanced: [{ torch: true }] });
                DOM.torchWarning.classList.add('hidden');
            } else {
                DOM.torchWarning.classList.remove('hidden');
            }
            
            return true;
        } catch (err) {
            console.error('Camera error:', err);
            alert('Camera access failed: ' + err.message);
            return false;
        }
    },
    
    getStats(track) {
        const s = track.getSettings();
        return {
            resolution: `${s.width}x${s.height}`,
            fps: s.frameRate ? s.frameRate.toFixed(1) : '--',
            exposure: s.exposureCompensation ?? s.exposureMode ?? '--',
            iso: s.iso ?? '--'
        };
    },
    
    stop() {
        if (this.stream) {
            if (this.torchSupported) {
                const track = this.stream.getVideoTracks()[0];
                if (track) track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
            this.torchSupported = false;
        }
        DOM.video.srcObject = null;
    }
};

// ============================================================================
// WAKE LOCK
// ============================================================================
const WakeLock = {
    lock: null,
    
    async acquire() {
        if ('wakeLock' in navigator && !this.lock) {
            try {
                this.lock = await navigator.wakeLock.request('screen');
                this.lock.addEventListener('release', () => { this.lock = null; });
                return true;
            } catch (err) {
                console.warn('Wake Lock error', err);
            }
        }
        return false;
    },
    
    async release() {
        if (this.lock) {
            try { await this.lock.release(); } 
            catch(e) { console.warn('Wake Lock release error', e); }
            this.lock = null;
        }
    }
};

// ============================================================================
// SIGNAL PROCESSING
// ============================================================================
const SignalProcessor = {
    recentValues: [],
    currentGain: 1.0,
    signalMean: 0,
    framesSinceStart: 0,
    simState: null,

    reset() {
        this.recentValues = [];
        this.currentGain = 1.0;
        this.signalMean = 0;
        this.framesSinceStart = 0;
        this.resetSimulation();
    },

    resetSimulation() {
        this.simState = {
            beatPhase: 0,       // seconds into the current beat
            beatDuration: 0,    // 0 = pick a fresh beat on the next sample
            beatAmplitude: 1,
            wanderPhase: Math.random() * 2 * Math.PI
        };
    },
    
    normalize(val) {
        this.recentValues.push(val);
        if (this.recentValues.length > CONSTANTS.SIGNAL.NORMALIZATION_WINDOW) {
            this.recentValues.shift();
        }
        
        let min = -0.01, max = 0.01;
        for (let v of this.recentValues) {
            if (v < min) min = v;
            if (v > max) max = v;
        }
        
        const targetGain = CONSTANTS.SIGNAL.TARGET_GAIN_RANGE / ((max - min) || 0.1);
        this.currentGain = (this.currentGain * CONSTANTS.SIGNAL.GAIN_SMOOTHING) + 
                          (targetGain * (1 - CONSTANTS.SIGNAL.GAIN_SMOOTHING));
        
        const normalized = val * this.currentGain;
        return Math.max(CONSTANTS.SIGNAL.SIGNAL_CLAMP_MIN, 
                       Math.min(CONSTANTS.SIGNAL.SIGNAL_CLAMP_MAX, normalized));
    },
    
    processFrame(videoElement, offscreenContext) {
        const size = CONSTANTS.CAMERA.PREVIEW_SIZE;
        offscreenContext.drawImage(videoElement, 0, 0, size, size);
        const data = offscreenContext.getImageData(0, 0, size, size).data;
        
        let sum = 0, count = 0;
        for (let i = 0; i < data.length; i += 16) {
            sum += data[i + 1];
            count++;
        }
        
        const avg = sum / count;
        const isSaturated = avg > CONSTANTS.SIGNAL.SATURATION_THRESHOLD;
        
        if (this.framesSinceStart < CONSTANTS.SIGNAL.WARMUP_FRAMES) {
            this.signalMean = avg;
            this.framesSinceStart++;
            return { signal: 0, isSaturated };
        }
        
        this.signalMean = (this.signalMean * 0.95) + (avg * 0.05);
        return { signal: this.normalize(this.signalMean - avg), isSaturated };
    },
    
    // Synthesizes a PPG-like waveform with real-world imperfections: per-beat
    // interval jitter (HRV), per-beat amplitude variation, slow baseline
    // wander, white noise and occasional motion-artifact spikes. dt is the
    // elapsed time since the previous sample, in seconds.
    generateSimulation(dt, targetBpm) {
        const SIM = CONSTANTS.SIMULATION;
        if (!this.simState) this.resetSimulation();
        const st = this.simState;

        if (st.beatDuration <= 0) this.startSimulationBeat(targetBpm);
        st.beatPhase += dt;
        while (st.beatPhase >= st.beatDuration) {
            st.beatPhase -= st.beatDuration;
            this.startSimulationBeat(targetBpm);
        }

        const t = st.beatPhase / st.beatDuration;
        const gaussian = ({ amplitude, center, width }) =>
            amplitude * Math.exp(-Math.pow(t - center, 2) / (2 * width * width));

        let signal = st.beatAmplitude *
            (gaussian(SIM.GAUSSIAN_QRS) + gaussian(SIM.GAUSSIAN_DICROTIC));

        st.wanderPhase += dt * 2 * Math.PI * SIM.BASELINE_WANDER_HZ;
        signal += Math.sin(st.wanderPhase) * SIM.BASELINE_WANDER_AMPLITUDE;
        signal += (Math.random() * 2 - 1) * SIM.NOISE_AMPLITUDE;
        if (Math.random() < SIM.ARTIFACTS_PER_SECOND * dt) {
            signal += (Math.random() * 2 - 1) * SIM.ARTIFACT_AMPLITUDE;
        }

        return this.normalize(signal * SIM.SIGNAL_SCALE);
    },

    // BPM slider changes take effect here, at the beat boundary, so there is
    // no mid-cycle phase jump in the waveform.
    startSimulationBeat(targetBpm) {
        const SIM = CONSTANTS.SIMULATION;
        this.simState.beatDuration =
            (60 / targetBpm) * (1 + (Math.random() * 2 - 1) * SIM.HRV_JITTER);
        this.simState.beatAmplitude =
            1 + (Math.random() * 2 - 1) * SIM.AMPLITUDE_JITTER;
    }
};

// ============================================================================
// BANDPASS FILTER
// ============================================================================
const BandpassFilter = {
    hp_prev_x: 0,
    hp_prev_y: 0,
    lp_prev_y: 0,

    reset() {
        this.hp_prev_x = 0;
        this.hp_prev_y = 0;
        this.lp_prev_y = 0;
    },

    process(x, dt) {
        const dt_s = Math.max(0.001, Math.min(dt, 0.1));

        // First-order high-pass: removes DC drift and baseline wander
        const hp_rc = 1 / (2 * Math.PI * CONSTANTS.FILTER.HP_CUTOFF_HZ);
        const hp_alpha = hp_rc / (hp_rc + dt_s);
        const hp_y = hp_alpha * (this.hp_prev_y + x - this.hp_prev_x);
        this.hp_prev_x = x;
        this.hp_prev_y = hp_y;

        // First-order low-pass: removes motion noise and high-frequency artifacts
        const lp_rc = 1 / (2 * Math.PI * CONSTANTS.FILTER.LP_CUTOFF_HZ);
        const lp_alpha = dt_s / (lp_rc + dt_s);
        const lp_y = lp_alpha * hp_y + (1 - lp_alpha) * this.lp_prev_y;
        this.lp_prev_y = lp_y;

        return lp_y;
    }
};

// ============================================================================
// FFT + FFT ANALYZER
// ============================================================================

// Radix-2 Cooley-Tukey FFT. Applies a Hann window then returns the first N/2
// magnitude bins. N must be a power of two.
function fftMagnitude(signal) {
    const N = signal.length;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);

    // Copy with Hann window applied
    for (let i = 0; i < N; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
        real[i] = signal[i] * w;
    }

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
        }
    }

    // Butterfly passes
    for (let len = 2; len <= N; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
            let wR = 1, wI = 0;
            for (let j = 0; j < (len >> 1); j++) {
                const uR = real[i + j], uI = imag[i + j];
                const xR = real[i + j + (len >> 1)], xI = imag[i + j + (len >> 1)];
                const vR = wR * xR - wI * xI;
                const vI = wR * xI + wI * xR;
                real[i + j]              = uR + vR;
                imag[i + j]              = uI + vI;
                real[i + j + (len >> 1)] = uR - vR;
                imag[i + j + (len >> 1)] = uI - vI;
                const newWR = wR * cosA - wI * sinA;
                wI = wR * sinA + wI * cosA;
                wR = newWR;
            }
        }
    }

    // Magnitudes for positive frequencies only
    const mags = new Float32Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) {
        mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return mags;
}

const FFTAnalyzer = {
    buffer: [],
    timestamps: [],

    reset() {
        this.buffer = [];
        this.timestamps = [];
    },

    addSample(val, timestampMs) {
        this.buffer.push(val);
        this.timestamps.push(timestampMs);
        if (this.buffer.length > CONSTANTS.FFT.BUFFER_SIZE) {
            this.buffer.shift();
            this.timestamps.shift();
        }
    },

    computeBPM() {
        const N = CONSTANTS.FFT.BUFFER_SIZE;
        if (this.buffer.length < N) return 0;

        // Compute actual sample rate from timestamp span
        const spanMs = this.timestamps[N - 1] - this.timestamps[0];
        if (spanMs <= 0) return 0;
        const sampleRate = (N - 1) / (spanMs / 1000);

        const mags = fftMagnitude(this.buffer);

        const minBin = Math.ceil(CONSTANTS.FFT.MIN_BPM / 60 * N / sampleRate);
        const maxBin = Math.min(Math.floor(CONSTANTS.FFT.MAX_BPM / 60 * N / sampleRate), (N >> 1) - 1);

        let peakBin = minBin, peakMag = 0, bandSum = 0;
        for (let i = minBin; i <= maxBin; i++) {
            bandSum += mags[i];
            if (mags[i] > peakMag) { peakMag = mags[i]; peakBin = i; }
        }

        // Signal-quality gate: a real pulse puts the spectral peak far above the
        // in-band average (measured ratio >9 for finger-on signals, <2 for noise
        // or a flat no-finger frame). Below the floor there's no pulse, so report
        // 0 rather than a phantom BPM.
        const meanMag = bandSum / (maxBin - minBin + 1);
        if (peakMag <= 0 || peakMag < meanMag * CONSTANTS.FFT.MIN_PEAK_RATIO) return 0;

        // Parabolic interpolation for sub-bin frequency accuracy
        let trueBin = peakBin;
        if (peakBin > minBin && peakBin < maxBin) {
            const denom = 2 * mags[peakBin] - mags[peakBin - 1] - mags[peakBin + 1];
            if (denom > 0) {
                trueBin = peakBin + 0.5 * (mags[peakBin + 1] - mags[peakBin - 1]) / denom;
            }
        }

        return Math.round(trueBin * sampleRate / N * 60);
    }
};

// ============================================================================
// BEAT DETECTION
// ============================================================================
const BeatDetector = {
    lastBeatTime: Number.NEGATIVE_INFINITY,
    lastSampleTime: null,
    refractoryPeriod: CONSTANTS.BEAT_DETECTION.REFRACTORY_PERIOD_MS,
    runningMax: 0.1,
    threshold: CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD,
    detectedBeats: [],
    bpm: 0,
    prevSignal: 0,

    reset() {
        this.lastBeatTime = Number.NEGATIVE_INFINITY;
        this.lastSampleTime = null;
        this.refractoryPeriod = CONSTANTS.BEAT_DETECTION.REFRACTORY_PERIOD_MS;
        this.runningMax = 0.1;
        this.threshold = CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD;
        this.detectedBeats = [];
        this.bpm = 0;
        this.prevSignal = 0;
    },

    isPeak(prev, curr, threshold, runningMax) {
        return prev > threshold &&
               curr < prev &&
               runningMax > CONSTANTS.BEAT_DETECTION.MIN_AMPLITUDE;
    },

    // Trimmed mean of the recent inter-beat intervals: the top and bottom
    // quarter are dropped, so a missed beat (2x interval) or a stray double
    // detection (0.5x interval) cannot drag the BPM, while frame-quantized
    // intervals still average out to the true rate.
    robustInterval() {
        const intervals = [];
        for (let i = 1; i < this.detectedBeats.length; i++) {
            intervals.push(this.detectedBeats[i] - this.detectedBeats[i - 1]);
        }
        intervals.sort((a, b) => a - b);

        const trim = Math.floor(intervals.length / 4);
        let sum = 0, count = 0;
        for (let i = trim; i < intervals.length - trim; i++) {
            sum += intervals[i];
            count++;
        }
        return sum / count;
    },

    process(signal, timestamp, bpmWindow) {
        // A window < 2 can never form an inter-beat interval, which would peg
        // the BPM at 0; clamp regardless of the configured/persisted value so a
        // stale setting from before validation can't brick the readout.
        bpmWindow = Math.max(2, bpmWindow || CONSTANTS.BPM.DEFAULT_WINDOW);

        // Time-based decay so the adaptive threshold behaves the same
        // regardless of camera frame rate (torch mode often halves it).
        const dtMs = this.lastSampleTime === null ? 33 :
            Math.max(0, Math.min(timestamp - this.lastSampleTime, 100));
        this.lastSampleTime = timestamp;

        this.runningMax *= Math.pow(CONSTANTS.BEAT_DETECTION.DECAY_PER_SECOND, dtMs / 1000);
        this.threshold = Math.max(
            this.runningMax * CONSTANTS.BEAT_DETECTION.THRESHOLD_MULTIPLIER,
            CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD
        );

        if (signal > this.runningMax) this.runningMax = signal;

        let isBeat = false;

        // Fire when the previous sample was above threshold and signal is now declining.
        // Using prevSignal > threshold (not current signal) handles narrow peaks where
        // the only above-threshold sample is immediately followed by a drop below threshold.
        if (BeatDetector.isPeak(this.prevSignal, signal, this.threshold, this.runningMax) &&
            (timestamp - this.lastBeatTime) > this.refractoryPeriod) {

            this.lastBeatTime = timestamp;
            isBeat = true;
            this.detectedBeats.push(timestamp);

            while(this.detectedBeats.length > bpmWindow) {
                this.detectedBeats.shift();
            }

            if (this.detectedBeats.length >= 2) {
                const newBpm = CONSTANTS.BPM.MS_PER_MINUTE / this.robustInterval();

                this.bpm = this.bpm === 0 ? newBpm :
                    (this.bpm * CONSTANTS.BPM.SMOOTHING + newBpm * (1 - CONSTANTS.BPM.SMOOTHING));

                this.refractoryPeriod = Math.max(
                    CONSTANTS.BEAT_DETECTION.REFRACTORY_MIN_MS,
                    Math.min(
                        (CONSTANTS.BPM.MS_PER_MINUTE / this.bpm) * CONSTANTS.BEAT_DETECTION.REFRACTORY_FACTOR,
                        CONSTANTS.BEAT_DETECTION.REFRACTORY_MAX_MS
                    )
                );
            }
        }

        this.prevSignal = signal;
        return { isBeat, threshold: this.threshold, bpm: Math.round(this.bpm) };
    }
};

// ============================================================================
// RENDERER
// ============================================================================
const Renderer = {
    drawSignal(canvas, ppgCtx, data, mode, end) {
        if (!data || !data.length || end === 0) return;

        const cy = canvas.height / 2;
        const sy = canvas.height / 2.2;
        const color = mode === 'simulate' ? '#a855f7' : (mode === 'review' ? '#f59e0b' : '#ef4444');
        const pps = canvas.width / CONSTANTS.DISPLAY.WINDOW_SECONDS;
        const latestTime = data[end - 1].time;
        const windowStart = latestTime - CONSTANTS.DISPLAY.WINDOW_SECONDS;

        ppgCtx.textAlign = "center";
        ppgCtx.textBaseline = "bottom";
        ppgCtx.font = "9px monospace";
        // The signal stroke below sets lineWidth = 2; reset it here so the
        // grid and threshold lines don't inherit it on subsequent frames.
        ppgCtx.lineWidth = 1;

        // Time marker grid lines (computed from time, not from data indices)
        ppgCtx.strokeStyle = 'rgba(255,255,255,0.15)';
        ppgCtx.fillStyle = 'rgba(255,255,255,0.3)';
        for (let s = Math.ceil(windowStart); s <= Math.floor(latestTime); s++) {
            if (s < 0) continue; // no gridlines/labels before the recording starts
            const x = (s - windowStart) * pps;
            ppgCtx.beginPath();
            ppgCtx.moveTo(x, 0);
            ppgCtx.lineTo(x, canvas.height);
            ppgCtx.stroke();
            ppgCtx.fillText(s + 's', x, canvas.height - 2);
        }

        const signalPath = [];
        const thresholdPath = [];
        const beatMarkers = [];

        // Walk back from the newest visible sample instead of scanning from
        // index 0, so scrubbing a long recording stays O(window) per frame
        // rather than O(recording length).
        let start = end - 1;
        while (start > 0 && data[start - 1].time >= windowStart) start--;

        for (let i = start; i < end; i++) {
            const d = data[i];
            const x = (d.time - windowStart) * pps;
            if (x < 0) continue;
            const y = cy - d.val * sy;
            signalPath.push({ x, y });
            thresholdPath.push({ x, y: cy - d.threshold * sy });
            if (d.beat) beatMarkers.push({ x, y });
        }

        if (!signalPath.length) return;

        ppgCtx.beginPath();
        ppgCtx.strokeStyle = 'rgba(255,200,0,0.3)';
        ppgCtx.setLineDash([4, 4]);
        thresholdPath.forEach((p, i) => {
            i === 0 ? ppgCtx.moveTo(p.x, p.y) : ppgCtx.lineTo(p.x, p.y);
        });
        ppgCtx.stroke();
        ppgCtx.setLineDash([]);

        ppgCtx.beginPath();
        ppgCtx.strokeStyle = color;
        ppgCtx.lineWidth = 2;
        signalPath.forEach((p, i) => {
            i === 0 ? ppgCtx.moveTo(p.x, p.y) : ppgCtx.lineTo(p.x, p.y);
        });
        ppgCtx.stroke();

        const last = signalPath[signalPath.length - 1];
        const first = signalPath[0];
        ppgCtx.lineTo(last.x, canvas.height);
        ppgCtx.lineTo(first.x, canvas.height);
        ppgCtx.fillStyle = color + "20";
        ppgCtx.fill();

        ppgCtx.fillStyle = "#fff";
        beatMarkers.forEach(p => {
            ppgCtx.beginPath();
            ppgCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ppgCtx.fill();
        });
    }
};

// ============================================================================
// STORAGE
// ============================================================================
const Storage = {
    async save(recording) {
        const records = this.loadAll();
        
        if (Config.maxRecords > 0 && records.length >= Config.maxRecords) {
            records.splice(Config.maxRecords - 1);
        }

        const existingIndex = records.findIndex(r => r.id === recording.id);
        if (existingIndex >= 0) {
            records[existingIndex] = recording;
        } else {
            records.unshift(recording);
        }

        // localStorage has its own ~5MB cap, independent of the Storage API
        // quota that checkQuota() inspects, so setItem can still throw
        // QuotaExceededError. Evict oldest records (kept newest-first) until the
        // write fits rather than silently losing the new recording.
        while (true) {
            try {
                localStorage.setItem(CONSTANTS.STORAGE.KEY, JSON.stringify(records));
                return true;
            } catch (e) {
                if (records.length > 1) {
                    records.pop();
                    continue;
                }
                alert("Storage full — couldn't save recording. Delete old recordings and try again.");
                return false;
            }
        }
    },
    
    loadAll() {
        const raw = localStorage.getItem(CONSTANTS.STORAGE.KEY);
        if (!raw) return [];
        
        try {
            const records = JSON.parse(raw);
            return records.filter(r => r.v === CONSTANTS.VERSION && Array.isArray(r.samples));
        } catch(e) {
            console.error('Failed to load records', e);
            return [];
        }
    },
    
    delete(id) {
        const records = this.loadAll();
        localStorage.setItem(CONSTANTS.STORAGE.KEY, 
            JSON.stringify(records.filter(r => r.id !== id)));
    },
    
    deleteOldest(count = CONSTANTS.STORAGE.DELETE_BATCH_SIZE) {
        const records = this.loadAll();
        if (records.length === 0) return 0;
        
        const toDelete = Math.min(count, records.length);
        records.splice(records.length - toDelete, toDelete);
        localStorage.setItem(CONSTANTS.STORAGE.KEY, JSON.stringify(records));
        return toDelete;
    },
    
    exportAll() {
        const raw = localStorage.getItem(CONSTANTS.STORAGE.KEY);
        if (!raw) return null;
        return URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    },
    
    async checkQuota() {
        if (!navigator.storage || !navigator.storage.estimate) return true;
        
        try {
            const estimate = await navigator.storage.estimate();
            if (estimate.quota > 0) {
                const usageRatio = estimate.usage / estimate.quota;
                if (usageRatio > CONSTANTS.STORAGE.QUOTA_CRITICAL) {
                    alert("Storage full. Delete old recordings to continue.");
                    return false;
                }
            }
        } catch(e) {
            console.warn('Quota check failed', e);
        }
        return true;
    },
    
    getStorageSize() {
        const records = this.loadAll();
        return new Blob([JSON.stringify(records)]).size;
    }
};

// ============================================================================
// UI HELPERS
// ============================================================================
const UI = {
    switchTab(tab) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

        if (tab === 'history') {
            DOM.tabHistory.classList.add('active');
            DOM.contentHistory.classList.remove('hidden');
            renderRecordingsList();
        } else if (tab === 'settings') {
            DOM.tabSettings.classList.add('active');
            DOM.contentSettings.classList.remove('hidden');
        }
    },
    
    updateBPMDisplay(bpm, colorClass) {
        DOM.bpmDisplay.innerText = bpm > 0 ? bpm : '--';
        DOM.bpmDisplay.className = colorClass || '';
    },
    
    updateStorageInfo() {
        const records = Storage.loadAll();
        const sizeMB = (Storage.getStorageSize() / 1024 / 1024).toFixed(2);
        const percentage = (parseFloat(sizeMB) / CONSTANTS.STORAGE.MAX_STORAGE_MB) * 100;
        
        DOM.storageInfo.innerText = `${sizeMB}MB / ${CONSTANTS.STORAGE.MAX_STORAGE_MB}MB`;
        DOM.storageBar.style.width = Math.min(percentage, 100) + '%';
        DOM.recordCount.innerText = `${records.length} Recording${records.length !== 1 ? 's' : ''}`;
        
        const barClass = percentage > 90 ? 'storage-bar critical' : 
            (percentage > 70 ? 'storage-bar warning' : 'storage-bar');
        DOM.storageBar.className = barClass;
    },
    
    updateCameraStats(track) {
        const stats = Camera.getStats(track);
        DOM.statRes.innerText = stats.resolution;
        DOM.statFps.innerText = stats.fps;
        DOM.statExp.innerText = stats.exposure;
        DOM.statIso.innerText = stats.iso;
    },
    
    updateButtonsForMode(mode) {
        DOM.simulateBtn.innerText = mode === 'simulate' ? 'Stop' : 'Simulate';
        // Only offer Save for an un-saved real capture that is long enough to
        // be saveable; once saved (or for a capture the save path would refuse)
        // the button hides so a tap can't persist a duplicate or dead-end.
        const canSave = mode === 'idle' && AppState.recording.length > 0 &&
            !AppState.savedCurrent &&
            AppState.totalTime >= CONSTANTS.STORAGE.MIN_SAVE_SECONDS;
        DOM.saveBtn.classList.toggle('hidden', !canSave);
    }
};

// ============================================================================
// MODE MANAGEMENT
// ============================================================================
// Transitions are serialized on a promise chain: a request that arrives while
// another transition is in flight (e.g. camera startup awaiting getUserMedia)
// runs after it completes instead of being silently dropped. This keeps the
// original guarantee (overlapping transitions can't orphan a half-started
// camera stream with its torch on) while making `await setMode(...)` mean the
// transition really happened — openReview and the visibilitychange teardown
// rely on that.
let modeTransition = Promise.resolve();
function setMode(newMode) {
    modeTransition = modeTransition.then(async () => {
        // Check against the state at run time, not at request time: an
        // earlier queued transition may already have landed on newMode.
        if (AppState.mode === newMode) return;
        await applyMode(newMode);
    }).catch(err => console.error('Mode transition failed', err));
    return modeTransition;
}

async function applyMode(newMode) {
    const oldMode = AppState.mode;

    // Auto-save whenever we LEAVE camera mode — explicit stop, tab-switch, or
    // tapping a saved recording — so a live recording is never lost. Keyed on
    // the mode being left (not the destination) and only on real captures, so
    // simulation data is never persisted.
    if (oldMode === 'camera' && Config.autoSave && AppState.recording.length > 0) {
        await saveRecording();
    }
    // Discard simulation data on any change out of simulate mode so it can
    // never reach the save path.
    if (oldMode === 'simulate') {
        AppState.clearHistory();
    }

    if (oldMode === 'camera') {
        Camera.stop();
        await WakeLock.release();
    }

    AppState.mode = newMode;

    // Mode-owned overlays are cleared on every transition — not just into
    // idle — so review controls or camera warnings can't leak into another
    // mode (e.g. review -> simulate, camera -> review). Whatever the new mode
    // needs is re-raised below (Camera.start re-shows the torch warning).
    DOM.reviewControls.classList.remove('active');
    DOM.saturationWarning.classList.add('hidden');
    DOM.torchWarning.classList.add('hidden');

    if (newMode === 'idle') {
        DOM.instructionOverlay.classList.remove('hidden');
        DOM.modeBadge.classList.add('hidden');
        UI.updateBPMDisplay(0);

    } else if (newMode === 'camera') {
        const started = await Camera.start();
        if (!started) {
            AppState.mode = 'idle';
            return;
        }
        await WakeLock.acquire();
        AppState.clearHistory();
        SignalProcessor.reset();
        BeatDetector.reset();
        BandpassFilter.reset();
        FFTAnalyzer.reset();
        DOM.instructionOverlay.classList.add('hidden');
        DOM.modeBadge.classList.remove('hidden');
        DOM.modeBadge.innerText = 'CAMERA';
        
        const track = Camera.stream.getVideoTracks()[0];
        UI.updateCameraStats(track);
        
    } else if (newMode === 'simulate') {
        AppState.clearHistory();
        SignalProcessor.reset();
        BeatDetector.reset();
        BandpassFilter.reset();
        FFTAnalyzer.reset();
        DOM.instructionOverlay.classList.add('hidden');
        DOM.modeBadge.classList.remove('hidden');
        DOM.modeBadge.innerText = 'SIMULATE';
        
    } else if (newMode === 'review') {
        DOM.instructionOverlay.classList.add('hidden');
        DOM.reviewControls.classList.add('active');
        DOM.modeBadge.classList.remove('hidden');
        DOM.modeBadge.innerText = 'REVIEW';
    }
    
    UI.updateButtonsForMode(newMode);
}

// ============================================================================
// ACTIONS
// ============================================================================
// Guards a save already in flight: savedCurrent is only set after the async
// quota check + write complete, so a double-tap on Save could otherwise pass
// the savedCurrent check twice and persist duplicate records.
let savePending = false;

// `manual` distinguishes a user-initiated save (Save button) from the silent
// auto-save path: manual saves always get feedback, auto-saves stay quiet.
async function saveRecording(manual = false) {
    if (savePending || AppState.savedCurrent || AppState.recording.length === 0) return;

    if (AppState.totalTime < CONSTANTS.STORAGE.MIN_SAVE_SECONDS) {
        if (manual) alert("Too short to save (minimum 1 second)");
        return;
    }

    // Snapshot the record synchronously, before any await: a mode change
    // during the quota check can clearHistory() and would otherwise be read
    // back as an empty capture.
    // avgBpm is a true mean of the per-frame BPM across the whole capture (the
    // history list labels it "Avg BPM"), not just the final smoothed reading.
    const bpms = AppState.recording.map(h => h.bpm).filter(b => b > 0);
    const avgBpm = bpms.length
        ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : 0;

    const recording = {
        id: Date.now(),
        v: CONSTANTS.VERSION,
        timestamp: new Date().toISOString(),
        duration: AppState.totalTime,
        avgBpm,
        samples: AppState.recording.map(h => ({ t: h.time, v: h.val }))
    };

    savePending = true;
    try {
        if (!(await Storage.checkQuota())) return;

        if (!(await Storage.save(recording))) return;
        AppState.savedCurrent = true;
        UI.updateButtonsForMode(AppState.mode);
        renderRecordingsList();

        if (manual) {
            alert(`Saved! BPM: ${recording.avgBpm || 'N/A'}, Duration: ${recording.duration.toFixed(1)}s`);
        }
    } finally {
        savePending = false;
    }
}

// Blob URLs are revoked on a delay: a synchronous revoke right after click()
// can abort the download in some browsers.
function downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportGraphImage() {
    DOM.ppgCanvas.toBlob(blob => {
        if (!blob) return alert("Could not export image");
        downloadUrl(URL.createObjectURL(blob), `pulse-graph-${Date.now()}.png`);
    });
}

function exportAllData() {
    const url = Storage.exportAll();
    if (!url) return alert("No data to export");
    downloadUrl(url, `heart_rate_data_${Date.now()}.json`);
}

function saveSettings() {
    Config.showPreview = DOM.settingPreview.checked;
    Config.autoStopSeconds = parseInt(DOM.settingAutoStop.value) || 0;
    // Clamp to >= 2: a window of 1 keeps only a single beat, so no inter-beat
    // interval is ever formed and the BPM readout sticks at 0.
    const win = parseInt(DOM.settingBpmWindow.value);
    Config.bpmCalculationWindow = Number.isFinite(win)
        ? Math.max(2, Math.min(50, win)) : CONSTANTS.BPM.DEFAULT_WINDOW;
    Config.maxRecords = parseInt(DOM.settingMaxRecords.value) || 0;
    Config.autoSave = DOM.settingAutoSave.checked;

    Config.save();
    DOM.previewCanvas.classList.toggle('hidden', !Config.showPreview);
    // Intentionally no BeatDetector.reset() here: it ran on every keystroke
    // (oninput) and blanked the live BPM mid-recording. A BPM-window change is
    // absorbed by BeatDetector.process() on its own; no other setting needs it.
}

function loadSettings() {
    Config.load();
    DOM.settingPreview.checked = Config.showPreview;
    DOM.settingAutoStop.value = Config.autoStopSeconds;
    DOM.settingAutoSave.checked = Config.autoSave;
    if (DOM.settingUseFFT) DOM.settingUseFFT.checked = Config.useFFT;
    DOM.settingBpmWindow.value = Config.bpmCalculationWindow;
    DOM.settingMaxRecords.value = Config.maxRecords;
    DOM.previewCanvas.classList.toggle('hidden', !Config.showPreview);
}

// ============================================================================
// RECORDINGS LIST
// ============================================================================
function renderRecordingsList() {
    const records = Storage.loadAll();
    UI.updateStorageInfo();
    DOM.savedList.innerHTML = '';
    
    if (!records.length) {
        DOM.emptyState.classList.remove('hidden');
        return;
    }
    
    DOM.emptyState.classList.add('hidden');
    
    records.forEach(r => {
        const d = new Date(r.timestamp);
        const div = document.createElement('div');
        div.className = 'recording-item';
        
        div.innerHTML = `
            <div>
                <div style="font-weight: bold; color: #38bdf8; font-size: 12px;">
                    ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </div>
                <div style="font-size: 10px; color: #64748b;">
                    ${d.toLocaleDateString()} • ${r.duration.toFixed(1)}s
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="text-align: right;">
                    <div style="font-size: 9px; color: #64748b; text-transform: uppercase;">Avg BPM</div>
                    <div style="font-weight: bold; color: #e2e8f0; font-size: 14px;">${r.avgBpm}</div>
                </div>
                <button class="delete-btn del" data-id="${r.id}">✕</button>
            </div>
        `;
        
        div.onclick = (e) => {
            if (e.target.classList.contains('del')) {
                if (confirm('Delete this recording?')) {
                    Storage.delete(r.id);
                    renderRecordingsList();
                }
            } else {
                openReview(r);
            }
        };
        
        DOM.savedList.appendChild(div);
    });
}

async function openReview(recording) {
    // Await the transition so an in-flight camera auto-save reads the live
    // BeatDetector.bpm before the replay below resets the detector.
    await setMode('review');

    // Replay the stored signal through the exact same pipeline as live mode
    // so that beat markers and BPM values are identical to what was shown live.
    BeatDetector.reset();
    BandpassFilter.reset();
    FFTAnalyzer.reset();

    const reviewData = [];
    let lastBpm = 0;

    for (let i = 0; i < recording.samples.length; i++) {
        const sample = recording.samples[i];
        const prevSample = recording.samples[i - 1];
        // Convert recorded seconds to ms for the refractory-period arithmetic
        // that BeatDetector.process() performs — identical to the live rAF path.
        const timestampMs = sample.t * 1000;

        let processedSignal = sample.v;
        let fftBpm = 0;
        if (Config.useFFT) {
            const dt = prevSample ? (sample.t - prevSample.t) : (1 / 30);
            processedSignal = BandpassFilter.process(sample.v, dt);
            FFTAnalyzer.addSample(processedSignal, timestampMs);
            fftBpm = FFTAnalyzer.computeBPM();
        }

        const result = BeatDetector.process(processedSignal, timestampMs, Config.bpmCalculationWindow);

        // Mirror the live displayBpm so review matches what was shown live,
        // including FFT mode (otherwise review showed the threshold BPM).
        // The last known reading is carried forward so the scrubber can label
        // any position without re-scanning the recording every frame.
        const displayBpm = fftBpm > 0 ? fftBpm : result.bpm;
        if (displayBpm > 0) lastBpm = displayBpm;

        reviewData.push({
            time: sample.t,
            val: sample.v,
            threshold: result.threshold,
            beat: false,
            bpm: lastBpm
        });

        // Same retroactive peak-marking as live mode: the beat fires on the
        // declining sample, so mark the previous entry (the actual peak).
        if (result.isBeat && reviewData.length > 1) {
            reviewData[reviewData.length - 2].beat = true;
        }
    }

    AppState.reviewData = reviewData;

    DOM.historySlider.min = 0;
    DOM.historySlider.max = recording.samples.length;
    DOM.historySlider.value = recording.samples.length;
    AppState.reviewOffset = recording.samples.length;

    // Display the BPM that was live at the end of the recording.
    UI.updateBPMDisplay(lastBpm > 0 ? lastBpm : recording.avgBpm);
}

// ============================================================================
// ANIMATION LOOP
// ============================================================================
async function loop(timestamp) {
    const generation = loopGeneration;
    if (!AppState.lastTime) AppState.lastTime = timestamp;

    // Clamp dt so a long rAF gap (tab switch, GC pause) cannot inject a huge
    // time step into the recorded history or the simulation.
    const dt = Math.min((timestamp - AppState.lastTime) / 1000, 0.1);
    AppState.lastTime = timestamp;

    if (AppState.mode === 'camera' || AppState.mode === 'simulate') {
        AppState.totalTime += dt;
        
        if (Config.autoStopSeconds > 0 && AppState.totalTime >= Config.autoStopSeconds) {
            await setMode('idle');
        } else {
            let signal, isSaturated;
            
            if (AppState.mode === 'camera') {
                const result = SignalProcessor.processFrame(DOM.video, previewCtx);
                signal = result.signal;
                isSaturated = result.isSaturated;
                DOM.saturationWarning.classList.toggle('hidden', !isSaturated);
            } else {
                signal = SignalProcessor.generateSimulation(dt, AppState.simBpm);
            }
            
            let processedSignal = signal;
            if (Config.useFFT) {
                processedSignal = BandpassFilter.process(signal, dt);
                FFTAnalyzer.addSample(processedSignal, timestamp);
            }

            const result = BeatDetector.process(processedSignal, timestamp, Config.bpmCalculationWindow);

            const fftBpm = Config.useFFT ? FFTAnalyzer.computeBPM() : 0;
            const displayBpm = fftBpm > 0 ? fftBpm : result.bpm;
            if (displayBpm > 0) {
                UI.updateBPMDisplay(displayBpm);
            }

            // Beat fires one sample after the peak (on the declining edge).
            // Retroactively mark the previous history entry so the dot sits on the peak.
            if (result.isBeat && AppState.history.length > 0) {
                AppState.history[AppState.history.length - 1].beat = true;
            }
            AppState.addHistoryPoint(AppState.totalTime, signal, result.threshold, false, displayBpm);
        }
    }
    
    const data = AppState.mode === 'review' ? AppState.reviewData : AppState.history;
    if (data && data.length > 0) {
        const end = AppState.mode === 'review' ? AppState.reviewOffset : data.length;

        ppgCtx.fillStyle = '#0f172a';
        ppgCtx.fillRect(0, 0, DOM.ppgCanvas.width, DOM.ppgCanvas.height);
        Renderer.drawSignal(DOM.ppgCanvas, ppgCtx, data, AppState.mode, end);
        
        if (AppState.mode === 'review' && end > 0 && data[end - 1]) {
            const currentTime = data[end - 1].time;
            const totalTime = data[data.length - 1].time;
            DOM.reviewTimeDisplay.innerText = `-${(totalTime - currentTime).toFixed(1)}s`;

            // Read the running BPM stored at the current slider position.
            // These values were computed by the exact same BeatDetector.process()
            // algorithm used during live recording (with the last known reading
            // carried forward by openReview), so review and live are identical.
            if (data[end - 1].bpm > 0) {
                UI.updateBPMDisplay(data[end - 1].bpm);
            }
        }
    }
    
    if (generation === loopGeneration) {
        animationFrameId = requestAnimationFrame(loop);
    }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
DOM.tabHistory.onclick = () => UI.switchTab('history');
DOM.tabSettings.onclick = () => UI.switchTab('settings');

DOM.historySlider.oninput = e => AppState.reviewOffset = parseInt(e.target.value);
DOM.bpmSlider.oninput = e => {
    AppState.simBpm = parseInt(e.target.value);
    DOM.targetBpmValue.innerText = AppState.simBpm;
};

DOM.simulateBtn.onclick = () => setMode(AppState.mode === 'simulate' ? 'idle' : 'simulate');
DOM.saveBtn.onclick = () => saveRecording(true);
DOM.backToLiveBtn.onclick = () => setMode('idle');
DOM.exportImgBtn.onclick = exportGraphImage;
DOM.exportJsonBtn.onclick = exportAllData;

DOM.deleteOldestBtn.onclick = () => {
    const records = Storage.loadAll();
    if (records.length === 0) return alert("No records to delete");
    
    const toDelete = Math.min(CONSTANTS.STORAGE.DELETE_BATCH_SIZE, records.length);
    if (confirm(`Delete oldest ${toDelete} recording${toDelete > 1 ? 's' : ''}?`)) {
        Storage.deleteOldest();
        renderRecordingsList();
    }
};

DOM.settingPreview.onchange = saveSettings;
DOM.settingAutoStop.oninput = saveSettings;
DOM.settingAutoSave.onchange = saveSettings;
// Separate from saveSettings because toggling FFT must also flush filter
// state immediately so stale samples don't bleed into the new mode.
if (DOM.settingUseFFT) {
    DOM.settingUseFFT.onchange = () => {
        Config.useFFT = DOM.settingUseFFT.checked;
        Config.save();
        BandpassFilter.reset();
        FFTAnalyzer.reset();
    };
}
DOM.settingBpmWindow.oninput = saveSettings;
DOM.settingMaxRecords.oninput = saveSettings;

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        loopGeneration++;
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        // Route camera teardown through setMode so an in-progress recording is
        // auto-saved and the hardware/torch released exactly as an explicit stop
        // would be. Simulate just pauses with the cancelled frame and resumes on
        // return — there's no hardware to free and nothing to save.
        if (AppState.mode === 'camera') {
            setMode('idle');
        }
    } else if (!animationFrameId) {
        // Only start a loop if one isn't already queued: a frame queued before
        // the tab was hidden is merely paused, and starting a second here would
        // run two loops at once. Scheduling via rAF (rather than calling loop
        // directly) sets animationFrameId synchronously, closing that window.
        animationFrameId = requestAnimationFrame(loop);
    }
});

window.onpagehide = () => {
    Camera.stop();
    WakeLock.release();
};

// ============================================================================
// CANVAS RESIZE
// ============================================================================
function resizeCanvas() {
    const container = DOM.ppgCanvas.parentElement;
    DOM.ppgCanvas.width = container.clientWidth;
    DOM.ppgCanvas.height = container.clientHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ============================================================================
// CANVAS TAP TO RECORD
// ============================================================================
function handleCanvasTap() {
    if (AppState.mode === 'idle') {
        setMode('camera');
    } else {
        // camera, simulate and review all stop back to idle
        setMode('idle');
    }
}

// Interactive children of the canvas area (buttons, the review scrubber, the
// install banner) must not double as a canvas tap — e.g. scrubbing the review
// timeline or dismissing the install banner must not toggle recording.
const CANVAS_TAP_IGNORE = 'button, input, #reviewControls, #installBanner';

document.getElementById('canvasContainer').addEventListener('touchstart', e => {
    if (e.target.closest(CANVAS_TAP_IGNORE)) return;
    e.preventDefault();
    handleCanvasTap();
}, { passive: false });

document.getElementById('canvasContainer').addEventListener('click', e => {
    if (e.target.closest(CANVAS_TAP_IGNORE)) return;
    handleCanvasTap();
});

// ============================================================================
// INITIALIZATION
// ============================================================================
loadSettings();
renderRecordingsList();
UI.switchTab('history');
loop(performance.now());

(function() {
    const versionEl = document.getElementById('versionInfo');
    if (!versionEl) return;
    const ua = navigator.userAgent;
    let browser = 'Browser';
    // navigator.brave is only defined in Brave; its UA string otherwise says "Chrome"
    if (navigator.brave) browser = 'Brave';
    else if (ua.includes('SamsungBrowser')) browser = 'Samsung';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('OPR') || ua.includes('Opera')) browser = 'Opera';
    else if (ua.includes('Chrome')) browser = 'Chrome';
    else if (ua.includes('Safari')) browser = 'Safari';
    versionEl.textContent = `${APP_CACHE} · ${browser}`;
})();

// ============================================================================
// SERVICE WORKER REGISTRATION
// ============================================================================
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ============================================================================
// PWA INSTALL PROMPT
// ============================================================================
(function() {
    const DISMISS_KEY = 'pwa-install-dismissed';
    if (localStorage.getItem(DISMISS_KEY)) return;
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;

    const banner = document.getElementById('installBanner');
    const installBtn = document.getElementById('installBtn');
    const dismissBtn = document.getElementById('installDismissBtn');
    const hint = document.getElementById('installHint');

    let deferredPrompt = null;

    function showBanner() { banner.classList.remove('hidden'); }
    function hideBanner() {
        banner.classList.add('hidden');
        localStorage.setItem(DISMISS_KEY, '1');
    }

    dismissBtn.addEventListener('click', hideBanner);

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

    if (isIOS) {
        hint.textContent = 'Tap the Share button, then "Add to Home Screen"';
        installBtn.textContent = 'How?';
        installBtn.addEventListener('click', () => {
            alert('To install:\n1. Tap the Share button (⬆) at the bottom of Safari\n2. Scroll down and tap "Add to Home Screen"\n3. Tap "Add"');
        });
        setTimeout(showBanner, 1500);
    } else {
        window.addEventListener('beforeinstallprompt', e => {
            e.preventDefault();
            deferredPrompt = e;
            setTimeout(showBanner, 500);
        });

        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            deferredPrompt = null;
            hideBanner();
        });

        window.addEventListener('appinstalled', hideBanner);

        // Fallback for Android browsers that never fire beforeinstallprompt
        // (Firefox, Opera, etc.) — show generic "use browser menu" instructions.
        if (/android/i.test(navigator.userAgent)) {
            setTimeout(() => {
                if (deferredPrompt) return; // Chromium already handled it
                hint.textContent = 'Tap your browser menu (⋮) → "Add to Home Screen"';
                installBtn.textContent = 'How?';
                installBtn.addEventListener('click', () => {
                    alert('To install:\n1. Tap the menu button (⋮ or ☰) in your browser\n2. Tap "Add to Home Screen" or "Install app"\n3. Tap "Add"');
                });
                showBanner();
            }, 3000);
        }
    }
})();

