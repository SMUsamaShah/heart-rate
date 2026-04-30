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
        THRESHOLD_MULTIPLIER: 0.5,
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
    }
};

const Config = {
    showPreview: false,
    autoStopSeconds: 0,
    autoSave: false,
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
    
    addHistoryPoint(time, val, threshold, isBeat, bpm) {
        this.history.push({ time, val, threshold, beat: isBeat, bpm });
        if (this.history.length > DOM.ppgCanvas.width * 2) {
            this.history.shift();
        }
    },
    
    clearHistory() {
        this.history = [];
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
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
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
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
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
// BEAT DETECTION
// ============================================================================
const BeatDetector = {
    lastBeatTime: 0,
    refractoryPeriod: CONSTANTS.BEAT_DETECTION.REFRACTORY_PERIOD_MS,
    runningMax: 0.1,
    threshold: CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD,
    detectedBeats: [],
    bpm: 0,
    
    reset() {
        this.lastBeatTime = 0;
        this.refractoryPeriod = CONSTANTS.BEAT_DETECTION.REFRACTORY_PERIOD_MS;
        this.runningMax = 0.1;
        this.threshold = CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD;
        this.detectedBeats = [];
        this.bpm = 0;
    },
    
    process(signal, timestamp, bpmWindow) {
        this.runningMax *= CONSTANTS.BEAT_DETECTION.DECAY_RATE;
        this.threshold = Math.max(
            this.runningMax * CONSTANTS.BEAT_DETECTION.THRESHOLD_MULTIPLIER,
            CONSTANTS.BEAT_DETECTION.BASE_THRESHOLD
        );
        
        if (signal > this.runningMax) this.runningMax = signal;
        
        let isBeat = false;
        
        if (signal > this.threshold && 
            (timestamp - this.lastBeatTime) > this.refractoryPeriod &&
            this.runningMax > CONSTANTS.BEAT_DETECTION.MIN_AMPLITUDE) {
            
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
        
        samples.forEach((val, i) => {
            const { threshold, runningMax } = thresholds[i];
            
            if (val > threshold && 
                (i - lastBeatIndex) > CONSTANTS.BEAT_DETECTION.MIN_GAP_SAMPLES && 
                runningMax > CONSTANTS.BEAT_DETECTION.MIN_AMPLITUDE) {
                beatIndices.push(i);
                lastBeatIndex = i;
            }
        });
        
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
    drawSignal(canvas, ppgCtx, data, mode, viewStart, viewEnd) {
        if (!data || !data.length) return;
        
        const viewData = data.slice(viewStart, viewEnd);
        if (!viewData.length) return;

        const cy = canvas.height / 2;
        const sy = canvas.height / 2.2;
        const color = mode === 'simulate' ? '#a855f7' : (mode === 'review' ? '#f59e0b' : '#ef4444');
        
        ppgCtx.textAlign = "center";
        ppgCtx.textBaseline = "bottom";
        ppgCtx.font = "9px monospace";
        
        const signalPath = [];
        const thresholdPath = [];
        const beatMarkers = [];
        
        for (let i = 0; i < viewData.length; i++) {
            const d = viewData[i];
            const y = cy - d.val * sy;
            
            signalPath.push({ x: i, y });
            thresholdPath.push({ x: i, y: cy - d.threshold * sy });
            
            if (d.beat) beatMarkers.push({ x: i, y });
            
            if (i > 0) {
                const prevTime = viewData[i - 1].time;
                if (Math.floor(d.time) !== Math.floor(prevTime)) {
                    ppgCtx.beginPath();
                    ppgCtx.strokeStyle = 'rgba(255,255,255,0.15)';
                    ppgCtx.moveTo(i, 0);
                    ppgCtx.lineTo(i, canvas.height);
                    ppgCtx.stroke();
                    
                    ppgCtx.fillStyle = 'rgba(255,255,255,0.3)';
                    ppgCtx.fillText(Math.floor(d.time) + 's', i, canvas.height - 2);
                }
            }
        }
        
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
        
        ppgCtx.lineTo(viewData.length - 1, canvas.height);
        ppgCtx.lineTo(0, canvas.height);
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
        const canSave = mode === 'idle' && AppState.history.length > 0;
        DOM.saveBtn.classList.toggle('hidden', !canSave);
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

function openReview(recording) {
    setMode('review');
    
    const values = recording.samples.map(s => s.v);
    const timestamps = recording.samples.map(s => s.t);
    
    const thresholds = BeatDetector.calculateThreshold(values);
    const beatIndices = BeatDetector.detectBeats(values, thresholds);
    const calculatedBpm = BeatDetector.calculateBPM(beatIndices, timestamps, Config.bpmCalculationWindow);

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
            
            const result = BeatDetector.process(signal, timestamp, Config.bpmCalculationWindow);
            
            if (result.bpm > 0) {
                UI.updateBPMDisplay(result.bpm);
            }
            
            AppState.addHistoryPoint(AppState.totalTime, signal, result.threshold, result.isBeat, result.bpm);
        }
    }
    
    const data = AppState.mode === 'review' ? AppState.reviewData : AppState.history;
    if (data && data.length > 0) {
        const end = AppState.mode === 'review' ? AppState.reviewOffset : data.length;
        const start = Math.max(0, end - DOM.ppgCanvas.width);
        
        ppgCtx.fillStyle = '#0f172a';
        ppgCtx.fillRect(0, 0, DOM.ppgCanvas.width, DOM.ppgCanvas.height);
        Renderer.drawSignal(DOM.ppgCanvas, ppgCtx, data, AppState.mode, start, end);
        
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
// CANVAS TAP TO RECORD
// ============================================================================
document.getElementById('canvasContainer').addEventListener('touchstart', e => {
    const mode = AppState.mode;
    if (mode === 'review') return;
    e.preventDefault();
    if (mode === 'idle') {
        setMode('camera');
    } else if (mode === 'camera' || mode === 'simulate') {
        setMode('idle');
    }
}, { passive: false });

document.getElementById('canvasContainer').addEventListener('click', e => {
    const mode = AppState.mode;
    if (mode === 'review') return;
    if (mode === 'idle') {
        setMode('camera');
    } else if (mode === 'camera' || mode === 'simulate') {
        setMode('idle');
    }
});

// ============================================================================
// INITIALIZATION
// ============================================================================
loadSettings();
renderRecordingsList();
UI.switchTab('history');
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

