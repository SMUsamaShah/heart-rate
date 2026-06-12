// Loads the real, unmodified script.js into a Node `vm` sandbox with just
// enough DOM stubbed out for it to initialize, and hands back the internal
// modules (BeatDetector, SignalProcessor, ...) for the test suite to drive.
//
// Math.random inside the sandbox is replaced with a seeded PRNG so every
// test run is reproducible.
'use strict';

const vm = require('vm');
const fs = require('fs');

// Deterministic PRNG (mulberry32)
function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeClassList() {
    const classes = new Set();
    return {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        toggle: (name, force) => {
            const on = force === undefined ? !classes.has(name) : !!force;
            on ? classes.add(name) : classes.delete(name);
            return on;
        },
        contains: name => classes.has(name)
    };
}

// Canvas 2D context stub: every method is a no-op, every property sticks,
// getImageData returns a black frame.
function makeContext2d() {
    const noop = () => {};
    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'getImageData') {
                return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
            }
            return prop in target ? target[prop] : noop;
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        }
    });
}

function makeElement(id) {
    return {
        id,
        value: '',
        checked: false,
        innerText: '',
        innerHTML: '',
        textContent: '',
        className: '',
        style: {},
        width: 360,
        height: 240,
        min: '',
        max: '',
        srcObject: null,
        classList: makeClassList(),
        parentElement: { clientWidth: 360, clientHeight: 240 },
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: () => {},
        removeChild: () => {},
        getContext: () => makeContext2d(),
        toBlob: () => {},
        closest: () => null,
        play: async () => {}
    };
}

function createSandbox(seed) {
    const elements = new Map();
    const getElementById = id => {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    };

    // Pre-dismiss the PWA install banner so its IIFE exits immediately.
    const storage = new Map([['pwa-install-dismissed', '1']]);

    const sandbox = {
        document: {
            getElementById,
            querySelectorAll: () => [],
            createElement: tag => makeElement(tag),
            addEventListener: () => {},
            body: { appendChild: () => {}, removeChild: () => {} },
            hidden: false
        },
        navigator: { userAgent: 'PulseTestHarness' },
        localStorage: {
            getItem: k => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: k => storage.delete(k),
            clear: () => storage.clear()
        },
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {},
        alert: () => {},
        confirm: () => true,
        console,
        Blob,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        __seededRandom: seededRandom(seed)
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => {};
    return sandbox;
}

// Returns the app's internal modules plus the sandbox itself.
function loadApp(scriptPath, seed = 1) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const context = vm.createContext(createSandbox(seed));
    vm.runInContext('Math.random = __seededRandom;', context);

    // The modules are top-level `const`s, so they are not reachable through
    // the context global object; grab them via the script completion value.
    const modules = vm.runInContext(
        code + '\n;({ CONSTANTS, Config, AppState, SignalProcessor, BandpassFilter, FFTAnalyzer, BeatDetector });',
        context,
        { filename: scriptPath }
    );
    return { ...modules, context };
}

module.exports = { loadApp, seededRandom };
