// Run the real page startup and event handlers with a window, clock and renderer supplied by the test.
// Placement, reactions and animation math still use the production modules.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../../web/vendor/three.module.js';
import * as model from '../../web/vendor/model.mjs';
import * as places from '../../web/places.js';
import * as reactions from '../../web/reactions.js';

const source = readFileSync(new URL('../../web/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');

export const monitor = (x, y, width, height, scaleFactor = 1) => ({ workArea: { position: { x, y }, size: { width, height } }, scaleFactor });

export async function companion({ saved = null, monitors = [monitor(0, 0, 1920, 1040)], origin = { x: 1626, y: 800 } } = {}) {
  let time = Date.parse('2026-11-09T12:00:00Z');
  let timerId = 0;
  const timers = new Map();
  const events = new Map();
  const storage = new Map(saved === null ? [] : [['spot', saved]]);
  const positions = [];
  const reports = [];
  const canvas = { addEventListener() {}, getContext: () => new Proxy({}, { get: () => () => {} }) };
  const gl = { drawingBufferWidth: 270, drawingBufferHeight: 240, getParameter: () => 'test' };
  const register = (name, fn) => { events.set(name, fn); return Promise.resolve(() => events.delete(name)); };
  const win = {
    outerPosition: async () => origin,
    onMoved: (fn) => register('moved', fn),
    onScaleChanged: (fn) => register('scale', fn),
    setPosition: async ({ x, y }) => { positions.push({ x, y }); },
    setIgnoreCursorEvents: async () => {},
    show: async () => {},
  };
  class Renderer {
    domElement = canvas;
    getContext() { return gl; }
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
  }
  class Loader {
    async loadAsync() { return { scene: new THREE.Group(), animations: [new THREE.AnimationClip('idle', 1, [])] }; }
  }
  class TestDate extends Date {
    static now() { return time; }
  }
  class Clock {
    last = time;
    getDelta() { const dt = (time - this.last) / 1000; this.last = time; return dt; }
  }
  const context = vm.createContext({
    ...model, ...places, ...reactions,
    THREE: { ...THREE, WebGLRenderer: Renderer, Clock },
    GLTFLoader: Loader,
    cloneSkeleton: (scene) => scene.clone(),
    console,
    Date: TestDate,
    performance: { now: () => time },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { hidden: false, body: { append() {} }, createElement: () => canvas },
    window: {
      innerWidth: 270, innerHeight: 240, devicePixelRatio: 1, addEventListener() {},
      __TAURI__: {
        core: { invoke: async (command, data) => { if (command === 'report') reports.push(data.message); } },
        event: { listen: register },
        dpi: { PhysicalPosition: class { constructor(x, y) { Object.assign(this, { x, y }); } } },
        window: { getCurrentWindow: () => win, availableMonitors: async () => monitors },
      },
    },
  });
  await new vm.Script(`(async () => { ${source}\n})()`, { filename: 'web/main.js' }).runInContext(context);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return {
    positions, reports,
    saved: () => storage.get('spot'),
    emit: async (name, payload) => { await events.get(name)?.({ payload }); await flush(); },
    advance: async (ms) => {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        time = timer.at;
        await timer.fn();
        await flush();
      }
      time = end;
    },
  };
}
