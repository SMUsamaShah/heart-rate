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
        MIN_GAP_SAMPLES: 15,
        MIN_AMPLITUDE: 0.15,
        DECAY_RATE: 0.99,
        THRESHOLD_MULTIPLIER: 0.45,
        BASE_THRESHOLD: 0.05,
        REFRACTORY_PERIOD_MS: 250,
        REFRACTORY_MIN_MS: 250,
        REFRACTORY_MAX_MS: 1000,
        REFRACTORY_FACTOR: 0.6
    },
    
    BPM: {
        DEFAULT_WINDOW: 8,
        SMOOTHING: 0.7,
        MS_PER_MINUTE: 60000
    },
    
    SIMULATION: {
        DEFAULT_BPM: 75,
        GAUSSIAN_P_WAVE: { amplitude: 0.3, center: 0.5, width: 0.12 },
        GAUSSIAN_QRS: { amplitude: 1.0, center: 0.2, width: 0.08 },
        NOISE_AMPLITUDE: 0.1,
        SIGNAL_SCALE: 0.05
    },
    
    STORAGE: {
        KEY: 'hr_records',
        SETTINGS_KEY: 'pulse_settings',
        QUOTA_CRITICAL: 0.95,
        MIN_SAVE_LENGTH: 60,
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
        MAX_BPM: 240
    },

    DISPLAY: {
        WINDOW_SECONDS: 10,
        HISTORY_SECONDS: 20
    }
};

const Config = {
    showPreview: false,
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
    emptyState: document.getElementById('emptyState'),

    // New UI elements
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    recordTimer: document.getElementById('recordTimer'),
    timerDisplay: document.getElementById('timerDisplay'),
    cameraFab: document.getElementById('cameraFab'),
    navHome: document.getElementById('navHome'),
    navSettings: document.getElementById('navSettings'),
    avgBpmDisplay: document.getElementById('avgBpmDisplay'),
    maxBpmDisplay: document.getElementById('maxBpmDisplay'),
    minBpmDisplay: document.getElementById('minBpmDisplay'),
    gaugeCanvas: document.getElementById('gaugeCanvas'),
    gaugeEmoji: document.getElementById('gaugeEmoji'),
    zoneName: document.getElementById('zoneName'),
    zoneRange: document.getElementById('zoneRange'),
    bpmBadge: document.getElementById('bpmBadge'),
    windowSelect: document.getElementById('windowSelect')
};

const ppgCtx = DOM.ppgCanvas.getContext('2d', { alpha: false });
const previewCtx = DOM.previewCanvas.getContext('2d', { willReadFrequently: true });
const gaugeCtx = DOM.gaugeCanvas.getContext('2d');

// ============================================================================
// HEART RATE ZONES
// ============================================================================
const ZONES = [
    { name: 'Resting',  range: '< 60 BPM',      min: 0,   max: 60,  badge: 'Low',       badgeClass: 'low',      colorA: '#3b82f6', colorB: '#06b6d4', emoji: '😴' },
    { name: 'Fat Burn', range: '60–100 BPM',     min: 60,  max: 100, badge: 'Normal',    badgeClass: '',         colorA: '#f97316', colorB: '#f59e0b', emoji: '🔥' },
    { name: 'Cardio',   range: '100–140 BPM',    min: 100, max: 140, badge: 'Elevated',  badgeClass: 'elevated', colorA: '#ef4444', colorB: '#f97316', emoji: '💪' },
    { name: 'Peak',     range: '140–170 BPM',    min: 140, max: 170, badge: 'High',      badgeClass: 'high',     colorA: '#dc2626', colorB: '#ef4444', emoji: '⚡' },
    { name: 'Maximum',  range: '170+ BPM',        min: 170, max: 300, badge: 'Very High', badgeClass: 'high',     colorA: '#991b1b', colorB: '#dc2626', emoji: '🚀' },
];

function getZone(bpm) {
    if (!bpm || bpm <= 0) return null;
    return ZONES.find(z => bpm >= z.min && bpm < z.max) || ZONES[ZONES.length - 1];
}

function drawGauge(bpm) {
    const W = DOM.gaugeCanvas.width;
    const H = DOM.gaugeCanvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const r = W * 0.37;
    const lw = W * 0.13;
    const DEG = Math.PI / 180;
    const gapStart = 225 * DEG;
    const gapEnd = 315 * DEG;

    gaugeCtx.clearRect(0, 0, W, H);
    gaugeCtx.lineWidth = lw;
    gaugeCtx.lineCap = 'round';

    // Background track
    gaugeCtx.beginPath();
    gaugeCtx.strokeStyle = '#1e2940';
    gaugeCtx.arc(cx, cy, r, gapStart, gapEnd, true);
    gaugeCtx.stroke();

    const zone = getZone(bpm);
    if (!zone) return;

    const fill = Math.max(0.05, Math.min(1, (bpm - zone.min) / (zone.max - zone.min)));
    const fillEnd = gapStart - fill * (270 * DEG);
    const grad = gaugeCtx.createLinearGradient(0, H, W, 0);
    grad.addColorStop(0, zone.colorA);
    grad.addColorStop(1, zone.colorB);

    gaugeCtx.beginPath();
    gaugeCtx.strokeStyle = grad;
    gaugeCtx.arc(cx, cy, r, gapStart, fillEnd, true);
    gaugeCtx.stroke();
}

let animationFrameId;

// ============================================================================
// APP STATE
// ============================================================================
const AppState = {
    mode: 'idle',
    totalTime: 0,
    lastTime: null,
    simPhase: 0,
    simBpm: CONSTANTS.SIMULATION.DEFAULT_BPM,
    history: [],
    reviewData: null,
    reviewOffset: 0,
    windowSeconds: 20,
    minBpm: 0,
    maxBpm: 0,
    bpmSum: 0,
    bpmCount: 0,

    addHistoryPoint(time, val, threshold, isBeat, bpm) {
        this.history.push({ time, val, threshold, beat: isBeat, bpm });
        const cutoff = time - 60;
        while (this.history.length > 1 && this.history[0].time < cutoff) {
            this.history.shift();
        }
    },

    clearHistory() {
        this.history = [];
        this.totalTime = 0;
        this.lastTime = null;
        this.minBpm = 0;
        this.maxBpm = 0;
        this.bpmSum = 0;
        this.bpmCount = 0;
    },

    updateBpmStats(bpm) {
        if (!bpm || bpm <= 0) return;
        if (this.minBpm === 0 || bpm < this.minBpm) this.minBpm = bpm;
        if (bpm > this.maxBpm) this.maxBpm = bpm;
        this.bpmSum += bpm;
        this.bpmCount++;
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
                    frameRate: { ideal: 60, min: 30 }
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
            exposure: s.exposureCompensation || s.exposureMode || '--',
            iso: s.iso || '--'
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
    
    reset() {
        this.recentValues = [];
        this.currentGain = 1.0;
        this.signalMean = 0;
        this.framesSinceStart = 0;
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
    
    generateSimulation(phase, bpm, totalTime) {
        const duration = 60 / bpm;
        const t = (phase % duration) / duration;
        
        const gaussian = (params) => {
            const { amplitude, center, width } = params;
            return amplitude * Math.exp(-Math.pow(t - center, 2) / (2 * width * width));
        };
        
        const signal = 
            gaussian(CONSTANTS.SIMULATION.GAUSSIAN_QRS) + 
            gaussian(CONSTANTS.SIMULATION.GAUSSIAN_P_WAVE) + 
            Math.sin(totalTime) * CONSTANTS.SIMULATION.NOISE_AMPLITUDE;
        
        return this.normalize(signal * CONSTANTS.SIMULATION.SIGNAL_SCALE);
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

        let peakBin = minBin, peakMag = 0;
        for (let i = minBin; i <= maxBin; i++) {
            if (mags[i] > peakMag) { peakMag = mags[i]; peakBin = i; }
        }

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
    lastBeatTime: 0,
    refractoryPeriod: CONSTANTS.BEAT_DETECTION.REFRACTORY_PERIOD_MS,
    runningMax: 0.1,
    threshold: CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD,
    detectedBeats: [],
    bpm: 0,
    prevSignal: 0,

    reset() {
        this.lastBeatTime = 0;
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

    process(signal, timestamp, bpmWindow) {
        this.runningMax *= CONSTANTS.BEAT_DETECTION.DECAY_RATE;
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
                let sum = 0;
                for (let i = 1; i < this.detectedBeats.length; i++) {
                    sum += (this.detectedBeats[i] - this.detectedBeats[i-1]);
                }
                
                const avgInterval = sum / (this.detectedBeats.length - 1);
                const newBpm = CONSTANTS.BPM.MS_PER_MINUTE / avgInterval;
                
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
    },

    calculateThreshold(samples) {
        let runningMax = 0.1;
        const results = [];
        
        samples.forEach(val => {
            runningMax *= CONSTANTS.BEAT_DETECTION.DECAY_RATE;
            if (val > runningMax) runningMax = val;
            
            const threshold = Math.max(
                runningMax * CONSTANTS.BEAT_DETECTION.THRESHOLD_MULTIPLIER,
                CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD
            );
            results.push({ threshold, runningMax });
        });
        
        return results;
    },
    
    detectBeats(samples, thresholds) {
        const beatIndices = [];
        let lastBeatIndex = -1000;

        for (let i = 1; i < samples.length; i++) {
            const { runningMax } = thresholds[i];
            const prevThreshold = thresholds[i - 1].threshold;
            const val = samples[i];
            const prevVal = samples[i - 1];

            // Same logic as process(): fire when previous sample was above threshold
            // and signal is now declining. Handles narrow single-sample peaks.
            if (BeatDetector.isPeak(prevVal, val, prevThreshold, runningMax) &&
                (i - lastBeatIndex) > CONSTANTS.BEAT_DETECTION.MIN_GAP_SAMPLES) {
                beatIndices.push(i - 1); // mark at the peak sample
                lastBeatIndex = i - 1;
            }
        }

        return beatIndices;
    },
    
    calculateBPM(beatIndices, timestamps, windowSize) {
        if (beatIndices.length < 2 || !timestamps) return null;
        
        const recent = beatIndices.slice(-windowSize);
        if (recent.length < 2) return null;
        
        const timeSpan = timestamps[recent[recent.length - 1]] - timestamps[recent[0]];
        if (timeSpan <= 0) return null;
        
        return Math.round(60 * (recent.length - 1) / timeSpan);
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
        const windowSec = AppState.windowSeconds || CONSTANTS.DISPLAY.WINDOW_SECONDS;
        const pps = canvas.width / windowSec;
        const latestTime = data[end - 1].time;
        const windowStart = latestTime - windowSec;
        const markerInterval = Math.max(1, Math.round(windowSec / 10));

        // Y-axis BPM scale (right side)
        ppgCtx.textAlign = 'right';
        ppgCtx.textBaseline = 'middle';
        ppgCtx.font = '9px system-ui';
        ppgCtx.fillStyle = 'rgba(255,255,255,0.35)';
        for (const bpm of [0, 30, 60, 90, 120]) {
            const y = cy - (bpm - 60) / 100 * sy;
            if (y >= 4 && y <= canvas.height - 4) {
                ppgCtx.fillText(bpm, canvas.width - 3, y);
                ppgCtx.beginPath();
                ppgCtx.strokeStyle = 'rgba(255,255,255,0.06)';
                ppgCtx.lineWidth = 1;
                ppgCtx.setLineDash([]);
                ppgCtx.moveTo(0, y);
                ppgCtx.lineTo(canvas.width - 22, y);
                ppgCtx.stroke();
            }
        }

        ppgCtx.textAlign = 'center';
        ppgCtx.textBaseline = 'bottom';
        ppgCtx.font = '9px system-ui';

        // Vertical time grid lines
        ppgCtx.strokeStyle = 'rgba(255,255,255,0.1)';
        ppgCtx.fillStyle = 'rgba(255,255,255,0.3)';
        for (let s = Math.ceil(windowStart / markerInterval) * markerInterval; s <= Math.floor(latestTime); s += markerInterval) {
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

        for (let i = 0; i < end; i++) {
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

        // Gradient fill under signal
        const last = signalPath[signalPath.length - 1];
        const first = signalPath[0];
        ppgCtx.beginPath();
        signalPath.forEach((p, i) => {
            i === 0 ? ppgCtx.moveTo(p.x, p.y) : ppgCtx.lineTo(p.x, p.y);
        });
        ppgCtx.lineTo(last.x, canvas.height);
        ppgCtx.lineTo(first.x, canvas.height);
        ppgCtx.closePath();
        const fillGrad = ppgCtx.createLinearGradient(0, 0, 0, canvas.height);
        fillGrad.addColorStop(0, color + '55');
        fillGrad.addColorStop(0.6, color + '20');
        fillGrad.addColorStop(1, color + '05');
        ppgCtx.fillStyle = fillGrad;
        ppgCtx.fill();

        // Signal glow
        ppgCtx.beginPath();
        ppgCtx.strokeStyle = color + '35';
        ppgCtx.lineWidth = 7;
        ppgCtx.setLineDash([]);
        signalPath.forEach((p, i) => {
            i === 0 ? ppgCtx.moveTo(p.x, p.y) : ppgCtx.lineTo(p.x, p.y);
        });
        ppgCtx.stroke();

        // Signal line
        ppgCtx.beginPath();
        ppgCtx.strokeStyle = color;
        ppgCtx.lineWidth = 2.5;
        signalPath.forEach((p, i) => {
            i === 0 ? ppgCtx.moveTo(p.x, p.y) : ppgCtx.lineTo(p.x, p.y);
        });
        ppgCtx.stroke();

        // Beat markers
        ppgCtx.fillStyle = '#fff';
        ppgCtx.shadowColor = '#fff';
        ppgCtx.shadowBlur = 6;
        beatMarkers.forEach(p => {
            ppgCtx.beginPath();
            ppgCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ppgCtx.fill();
        });
        ppgCtx.shadowBlur = 0;
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

        localStorage.setItem(CONSTANTS.STORAGE.KEY, JSON.stringify(records));
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
        DOM.bpmDisplay.className = 'bpm-number' + (colorClass ? ' ' + colorClass : '');
        UI.updateZoneUI(bpm);
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
        DOM.simulateBtn.innerText = mode === 'simulate' ? 'Stop' : 'Demo';
        const canSave = mode === 'idle' && AppState.history.length > 0;
        DOM.saveBtn.classList.toggle('hidden', !canSave);

        const recording = mode === 'camera' || mode === 'simulate';
        DOM.cameraFab.classList.toggle('recording', recording);
        DOM.recordTimer.classList.toggle('hidden', !recording);
        DOM.statusDot.classList.toggle('active', recording);
        DOM.statusText.innerText = mode === 'camera' ? 'Camera monitoring' :
            mode === 'simulate' ? 'Demo mode' : 'Ready';
    },

    updateZoneUI(bpm) {
        const zone = getZone(bpm);
        if (!zone || bpm <= 0) {
            DOM.bpmBadge.classList.add('hidden');
            DOM.zoneName.innerText = '--';
            DOM.zoneRange.innerText = '';
            DOM.gaugeEmoji.innerText = '💗';
            drawGauge(0);
            return;
        }
        DOM.bpmBadge.classList.remove('hidden');
        DOM.bpmBadge.innerText = zone.badge;
        DOM.bpmBadge.className = 'bpm-badge' + (zone.badgeClass ? ' ' + zone.badgeClass : '');
        DOM.zoneName.innerText = zone.name;
        DOM.zoneRange.innerText = zone.range;
        DOM.gaugeEmoji.innerText = zone.emoji;
        drawGauge(bpm);
    },

    updateStatsDisplay() {
        const avg = AppState.bpmCount > 0 ? Math.round(AppState.bpmSum / AppState.bpmCount) : 0;
        DOM.avgBpmDisplay.innerText = avg > 0 ? avg : '--';
        DOM.maxBpmDisplay.innerText = AppState.maxBpm > 0 ? AppState.maxBpm : '--';
        DOM.minBpmDisplay.innerText = AppState.minBpm > 0 ? AppState.minBpm : '--';
    },

    updateTimerDisplay() {
        const t = Math.floor(AppState.totalTime);
        const m = String(Math.floor(t / 60)).padStart(2, '0');
        const s = String(t % 60).padStart(2, '0');
        DOM.timerDisplay.innerText = `${m}:${s}`;
    }
};

// ============================================================================
// MODE MANAGEMENT
// ============================================================================
async function setMode(newMode) {
    if (AppState.mode === newMode) return;
    
    // AUTO-SAVE CHECK when stopping recording
    if ((AppState.mode === 'camera' || AppState.mode === 'simulate') && newMode === 'idle') {
        if (Config.autoSave && AppState.history.length > 0) {
            saveRecording();
        }
    }
    
    if (AppState.mode === 'camera') {
        Camera.stop();
        await WakeLock.release();
    }
    
    AppState.mode = newMode;
    
    if (newMode === 'idle') {
        DOM.instructionOverlay.classList.remove('hidden');
        DOM.modeBadge.classList.add('hidden');
        DOM.reviewControls.classList.remove('active');
        DOM.saturationWarning.classList.add('hidden');
        DOM.torchWarning.classList.add('hidden');
        UI.updateBPMDisplay(0);
        UI.updateStatsDisplay();
        
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
        AppState.simPhase = 0;
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
async function saveRecording() {
    if (AppState.history.length === 0) return;
    
    if (AppState.history.length < CONSTANTS.STORAGE.MIN_SAVE_LENGTH) {
        if (!Config.autoSave) {
            alert("Too short to save (minimum 1 second)");
        }
        return;
    }

    if (!(await Storage.checkQuota())) return;
    
    const recording = {
        id: Date.now(),
        v: CONSTANTS.VERSION,
        timestamp: new Date().toISOString(),
        duration: AppState.totalTime,
        avgBpm: Math.round(BeatDetector.bpm) || 0,
        samples: AppState.history.map(h => ({ t: h.time, v: h.val }))
    };
    
    await Storage.save(recording);
    renderRecordingsList();
    
    if (!Config.autoSave) {
        alert(`Saved! BPM: ${recording.avgBpm || 'N/A'}, Duration: ${AppState.totalTime.toFixed(1)}s`);
    }
}

function exportGraphImage() {
    DOM.ppgCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pulse-graph-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function exportAllData() {
    const url = Storage.exportAll();
    if (!url) return alert("No data to export");
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `heart_rate_data_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function saveSettings() {
    Config.showPreview = DOM.settingPreview.checked;
    Config.autoStopSeconds = parseInt(DOM.settingAutoStop.value) || 0;
    Config.bpmCalculationWindow = parseInt(DOM.settingBpmWindow.value) || CONSTANTS.BPM.DEFAULT_WINDOW;
    Config.maxRecords = parseInt(DOM.settingMaxRecords.value) || 0;
    Config.autoSave = DOM.settingAutoSave.checked;
    
    Config.save();
    DOM.previewCanvas.classList.toggle('hidden', !Config.showPreview);
    BeatDetector.reset();
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
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const timeStr = `${hh}:${mm}`;
        const day = String(d.getDate()).padStart(2, '0');
        const mon = String(d.getMonth() + 1).padStart(2, '0');
        const yr = d.getFullYear();
        const dateStr = `${day}/${mon}/${yr}`;
        const div = document.createElement('div');
        div.className = 'recording-item';

        div.innerHTML = `
            <div class="recording-icon">
                <svg width="18" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="1,7 4,7 6,1 9,13 12,4 15,7 21,7"/>
                </svg>
            </div>
            <div class="recording-info">
                <div class="recording-time">${timeStr}</div>
                <div class="recording-date">${dateStr} • ${r.duration.toFixed(1)}s</div>
            </div>
            <div class="recording-bpm">
                <div class="bpm-label-sm">AVG BPM</div>
                <div class="bpm-val-sm">${r.avgBpm || '--'}</div>
            </div>
            <span class="recording-chevron">›</span>
            <button class="delete-btn del" data-id="${r.id}">✕</button>
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

function openReview(recording) {
    setMode('review');
    
    const values = recording.samples.map(s => s.v);
    const timestamps = recording.samples.map(s => s.t);

    let analysisValues = values;
    if (Config.useFFT) {
        BandpassFilter.reset();
        analysisValues = values.map((v, i) => {
            const dt = i === 0 ? 1 / 30 : (timestamps[i] - timestamps[i - 1]);
            return BandpassFilter.process(v, dt);
        });
    }

    const thresholds = BeatDetector.calculateThreshold(analysisValues);
    const beatIndices = BeatDetector.detectBeats(analysisValues, thresholds);

    let calculatedBpm = BeatDetector.calculateBPM(beatIndices, timestamps, Config.bpmCalculationWindow);
    if (Config.useFFT) {
        FFTAnalyzer.reset();
        analysisValues.forEach((v, i) => FFTAnalyzer.addSample(v, timestamps[i] * 1000));
        const fftBpm = FFTAnalyzer.computeBPM();
        if (fftBpm > 0) calculatedBpm = fftBpm;
    }

    AppState.reviewData = recording.samples.map((sample, i) => ({
        time: sample.t,
        val: sample.v,
        threshold: thresholds[i].threshold,
        beat: beatIndices.includes(i),
        bpm: calculatedBpm || recording.avgBpm
    }));
    
    AppState.reviewData.duration = recording.duration;
    
    DOM.historySlider.min = 0;
    DOM.historySlider.max = recording.samples.length;
    DOM.historySlider.value = recording.samples.length;
    AppState.reviewOffset = recording.samples.length;
    
    UI.updateBPMDisplay(calculatedBpm || recording.avgBpm);
}

// ============================================================================
// ANIMATION LOOP
// ============================================================================
async function loop(timestamp) {
    if (!AppState.lastTime) AppState.lastTime = timestamp;
    
    const dt = (timestamp - AppState.lastTime) / 1000;
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
                AppState.simPhase += dt;
                signal = SignalProcessor.generateSimulation(AppState.simPhase, AppState.simBpm, AppState.totalTime);
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
                AppState.updateBpmStats(displayBpm);
                UI.updateStatsDisplay();
            }

            UI.updateTimerDisplay();

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

        ppgCtx.fillStyle = '#080d18';
        ppgCtx.fillRect(0, 0, DOM.ppgCanvas.width, DOM.ppgCanvas.height);
        Renderer.drawSignal(DOM.ppgCanvas, ppgCtx, data, AppState.mode, end);
        
        if (AppState.mode === 'review' && end > 0 && data[end - 1]) {
            const currentTime = data[end - 1].time;
            const totalTime = data[data.length - 1].time;
            DOM.reviewTimeDisplay.innerText = `-${(totalTime - currentTime).toFixed(1)}s`;
            
            const recentBeats = [];
            for (let i = end - 1; i >= 0 && recentBeats.length < Config.bpmCalculationWindow; i--) {
                if (data[i].beat) {
                    recentBeats.push(data[i].time);
                }
            }
            
            if (recentBeats.length >= 2) {
                const timeSpan = recentBeats[0] - recentBeats[recentBeats.length - 1];
                const displayBpm = Math.round(60 * (recentBeats.length - 1) / timeSpan);
                UI.updateBPMDisplay(displayBpm);
            }
        }
    }
    
    animationFrameId = requestAnimationFrame(loop);
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
DOM.cameraFab.onclick = () => {
    if (AppState.mode === 'idle') setMode('camera');
    else if (AppState.mode === 'camera' || AppState.mode === 'simulate') setMode('idle');
};
DOM.navHome.onclick = () => {
    DOM.navHome.classList.add('active');
    DOM.navSettings.classList.remove('active');
    UI.switchTab('history');
};
DOM.navSettings.onclick = () => {
    DOM.navSettings.classList.add('active');
    DOM.navHome.classList.remove('active');
    UI.switchTab('settings');
};
DOM.windowSelect.onchange = e => {
    AppState.windowSeconds = parseInt(e.target.value) || 20;
};
DOM.saveBtn.onclick = saveRecording;
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
        cancelAnimationFrame(animationFrameId);
        if (AppState.mode === 'camera') {
            Camera.stop();
            WakeLock.release();
            AppState.mode = 'idle';
            DOM.modeBadge.innerText = "PAUSED";
            UI.updateButtonsForMode('idle');
        }
    } else {
        loop(performance.now());
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
// CANVAS TAP — exits review mode only
// ============================================================================
document.getElementById('canvasContainer').addEventListener('click', () => {
    if (AppState.mode === 'review') setMode('idle');
});

// ============================================================================
// INITIALIZATION
// ============================================================================
loadSettings();
renderRecordingsList();
UI.switchTab('history');
drawGauge(0);
loop(performance.now());

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
    }
})();

