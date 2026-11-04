import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as cloneSkeleton } from './vendor/SkeletonUtils.js';
import { arrives, clipFor, hash, SHOWN_HELPERS, WORLDS } from './vendor/model.mjs';
import { applyEvent, reactionTo } from './reactions.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, cursorPosition } = window.__TAURI__.window;
const win = getCurrentWindow();

const FPS = 30;
const HIT_POLL_MS = 100; // how often the pixel under the cursor decides click-through
const HIT_ALPHA = 32; // of 255: anything fainter than this is not the character
const HIT_RADIUS = 2; // pixels round the cursor, so the outline is not a one-pixel target
const FIT_SAMPLES = 4; // poses sampled from each clip to fit the camera
const VIEW_DIRECTION = new THREE.Vector3(0.28, 0.32, 1); // a little above and to one side
const FADE = 0.25; // seconds between clips
const WALK_SECONDS = 1.6; // the Yard walks between places; here the walk plays where it stands
const SPIRIT_KEY = 'spirit';
const DEFAULT_SPIRIT = 3;

// The Yard's size and height (renderer.js helpers()). Its helperOffset ring needs its high camera: from
// this low one, helpers in the ring stand in front of the character or hide behind it. So they stand to
// either side, front ones nearest the camera, and a helper keeps its slot as others join.
const HELPER_SCALE = 0.45;
const HELPER_Y = 0.27;
const HELPER_SLOTS = [{ x: 0.95, z: 0.1 }, { x: -0.95, z: 0.1 }, { x: 0.8, z: -0.55 }, { x: -0.8, z: -0.55 }, { x: 1.05, z: 0.7 }, { x: -1.05, z: 0.7 }];
const GROVE = WORLDS.grove;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.65; // the Yard's light theme
document.body.append(renderer.domElement);
const gl = renderer.getContext();

// Grove's light rig from the Yard: WORLDS.grove in model.mjs and the sun and rim in renderer.js.
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(GROVE.hemi, 0x495741, 3));
const sun = new THREE.DirectionalLight(GROVE.sun.light, 4);
sun.position.set(-12, 25, 15);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x99c5ee, 1.4);
rim.position.set(8, 12, -15);
scene.add(rim);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
camera.position.copy(VIEW_DIRECTION).normalize().multiplyScalar(20);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const screenRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);

const loader = new GLTFLoader();
const assets = new Map();
const asset = (name) => {
  if (!assets.has(name)) assets.set(name, loader.loadAsync(`assets/${name}.glb`));
  return assets.get(name);
};

let character = null; // { model, mixer, clips, action, clip, height }
let fit = null; // what fitCamera last framed, to frame it again if the window changes size

/** Frames every clip's sampled poses, the ring of helpers and the marks above, so nothing is cut off. */
function fitCamera(model, mixer, clips, height) {
  const toView = camera.matrixWorldInverse;
  const point = new THREE.Vector3();
  const bounds = new THREE.Box2();
  const add = () => { point.applyMatrix4(toView); bounds.expandByPoint(new THREE.Vector2(point.x, point.y)); };
  for (const clip of clips) {
    const action = mixer.clipAction(clip).play();
    for (let n = 0; n < FIT_SAMPLES; n++) {
      mixer.setTime((clip.duration * n) / FIT_SAMPLES);
      model.updateMatrixWorld(true);
      model.traverse((node) => {
        if (!node.isSkinnedMesh) return;
        node.skeleton.update();
        const count = node.geometry.attributes.position.count;
        for (let v = 0; v < count; v += 16) {
          node.getVertexPosition(v, point).applyMatrix4(node.matrixWorld);
          add();
        }
      });
    }
    action.stop();
  }
  mixer.setTime(0);
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    point.set(Math.cos(angle) * 1.5, 0, Math.sin(angle) * 1.05); add();
    point.set(Math.cos(angle) * 1.5, HELPER_Y + 0.6, Math.sin(angle) * 1.05); add();
  }
  point.set(0, height + 0.5, 0).addScaledVector(screenRight, 1.1); add();
  fit = bounds;
  applyFit();
}

function applyFit() {
  const aspect = window.innerWidth / window.innerHeight;
  const size = fit.getSize(new THREE.Vector2());
  const halfHeight = (Math.max(size.y, size.x / aspect) * 1.02) / 2;
  const centerX = (fit.min.x + fit.max.x) / 2;
  const centerY = (fit.min.y + fit.max.y) / 2;
  camera.left = centerX - halfHeight * aspect;
  camera.right = centerX + halfHeight * aspect;
  camera.bottom = centerY - halfHeight;
  camera.top = centerY + halfHeight;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', () => {
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (fit) applyFit();
});

// The character's clips: the Yard's play, nextClip and crossTo (renderer.js).
function crossTo(name, loop) {
  const clip = character.clips.find((each) => each.name === name) ?? character.clips[0];
  const action = character.mixer.clipAction(clip);
  character.clip = name;
  if (action === character.action) return;
  action.reset();
  action.setLoop(loop, Infinity);
  action.clampWhenFinished = false;
  action.play();
  if (character.action) character.action.crossFadeTo(action, FADE, false);
  character.action = action;
}

function playMode() {
  if (!character || !reaction || walkingUntil) return;
  if (character.clip && character.clipMode === reaction.mode && character.clip !== 'walk') return;
  character.clipMode = reaction.mode;
  character.clipCount = 0;
  crossTo(clipFor(reaction.id, reaction.mode, 0), THREE.LoopOnce);
}

function nextClip() {
  if (!reaction || walkingUntil) return;
  character.clipCount += 1;
  const name = clipFor(reaction.id, character.clipMode, character.clipCount);
  if (name === character.clip) character.action.reset().play();
  else crossTo(name, THREE.LoopOnce);
}

function walkThen() {
  walkingUntil = performance.now() + WALK_SECONDS * 1000;
  if (character) crossTo('walk', THREE.LoopRepeat);
}

async function loadSpirit(n) {
  const gltf = await asset(`${GROVE.characters}${n}`);
  if (character) {
    scene.remove(character.model);
    character.mixer.stopAllAction();
    character.mixer.uncacheRoot(character.model);
  }
  const model = cloneSkeleton(gltf.scene);
  let yard = null;
  model.traverse((node) => {
    if (node.isMesh) node.frustumCulled = false;
    if (node.userData?.yard) yard = node.userData.yard;
  });
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations;
  const height = yard?.height ?? 2;
  fitCamera(model, mixer, clips, height);
  mixer.stopAllAction();
  scene.add(model);
  mixer.addEventListener('finished', nextClip);
  character = { model, mixer, clips, action: null, clip: null, clipMode: null, clipCount: 0, height };
  playMode();
}

// Helpers: the Yard's helpers() and helperClip() (renderer.js), round a character that stays put.
let helpers = [];
let helperSignature = '';
let helperRevision = 0;

function helperClip(helper, name) {
  const clip = helper.clips.find((each) => each.name === name) ?? helper.clips[0];
  if (!clip) return;
  const action = helper.mixer.clipAction(clip);
  if (action === helper.action) return;
  action.reset().play();
  if (helper.action) helper.action.crossFadeTo(action, FADE, false);
  helper.action = action;
}

async function syncHelpers(wanted) {
  const signature = JSON.stringify(wanted);
  if (signature === helperSignature) return;
  helperSignature = signature;
  const revision = ++helperRevision;
  const shown = wanted.slice(0, SHOWN_HELPERS);
  const built = await Promise.all(shown.map(async (agent, i) => {
    const model = await asset((agent.shell ? GROVE.helpers.shell : GROVE.helpers.agent) + (hash(agent.name || agent.id) % 4));
    return { agent, i, source: model };
  }));
  if (revision !== helperRevision) return;
  for (const helper of helpers) {
    scene.remove(helper.model);
    helper.mixer.stopAllAction();
    helper.mixer.uncacheRoot(helper.model);
  }
  helpers = built.map(({ agent, i, source }) => {
    const model = cloneSkeleton(source.scene);
    const offset = HELPER_SLOTS[i];
    model.scale.setScalar(HELPER_SCALE);
    model.position.set(offset.x, HELPER_Y, offset.z);
    let yard = null;
    model.traverse((node) => {
      if (node.isMesh) node.frustumCulled = false;
      if (node.userData?.yard) yard = node.userData.yard;
    });
    scene.add(model);
    const helper = { id: agent.id, model, mixer: new THREE.AnimationMixer(model), clips: source.animations, action: null, top: (yard?.height ?? 1) * HELPER_SCALE };
    helperClip(helper, agent.pose);
    helper.mixer.update(0.3 + (hash(agent.id) % 40) / 10);
    return helper;
  });
}

// Marks: the Yard's MARKS, glyphs and stepMarks (renderer.js).
const MARKS = {
  asleep: { glyph: 'z', count: 3, size: 0.62 },
  waiting: { glyph: 'bang', color: '#ffc23d', count: 1, size: 0.78 },
  failed: { glyph: 'bang', color: '#ff4d4f', count: 1, size: 0.78 },
  exited: { glyph: 'bang', color: '#ffffff', count: 1, size: 0.78 },
};
const MARK_FADE = 0.3;
const GLYPHS = {
  z: (c) => { c.beginPath(); c.moveTo(36, 36); c.lineTo(92, 36); c.lineTo(36, 92); c.lineTo(92, 92); c.stroke(); },
  bang: (c, w) => { c.beginPath(); c.moveTo(64, 22); c.lineTo(64, 70); c.stroke(); c.beginPath(); c.arc(64, 100, w * 0.55, 0, Math.PI * 2); c.fill(); },
};
function glyph(draw) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const c = canvas.getContext('2d');
  c.lineCap = c.lineJoin = 'round';
  c.shadowColor = 'rgba(0,0,0,.45)';
  for (const [width, color, blur] of [[30, 'rgba(16,12,10,.85)', 12], [15, '#fff', 0]]) {
    c.lineWidth = width;
    c.strokeStyle = c.fillStyle = color;
    c.shadowBlur = blur;
    draw(c, width);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const glyphs = { z: glyph(GLYPHS.z), bang: glyph(GLYPHS.bang) };
const markPlane = new THREE.PlaneGeometry(1, 1);
const marks = new Map(); // `${anchor}:${kind}` -> mark; anchor is a helper's id, or '' for the character
const turn = new THREE.Quaternion();
const axisZ = new THREE.Vector3(0, 0, 1);

function syncMarks() {
  const want = new Map(reaction.helperMarks.map((id) => [id, 'waiting']));
  if (reaction.crewMark) want.set('', reaction.crewMark);
  for (const mark of marks.values()) mark.target = want.get(mark.anchor) === mark.kind ? 1 : 0;
  for (const [anchor, kind] of want) {
    const key = `${anchor}:${kind}`;
    if (marks.has(key)) continue;
    const spec = MARKS[kind];
    const sprites = Array.from({ length: spec.count }, () => {
      const sprite = new THREE.Mesh(markPlane, new THREE.MeshBasicMaterial({ map: glyphs[spec.glyph], color: spec.color ?? '#d0ba82', transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }));
      sprite.renderOrder = 21;
      sprite.visible = false;
      scene.add(sprite);
      return sprite;
    });
    marks.set(key, { anchor, kind, spec, sprites, target: 1, alpha: 0, age: 0, seed: (hash(reaction.id + anchor) % 1000) / 1000 });
  }
}

function stepMarks(dt) {
  for (const [key, mark] of marks) {
    const on = mark.target && !(mark.kind === 'asleep' && walkingUntil) ? 1 : 0;
    mark.age += dt;
    mark.alpha = Math.max(0, Math.min(1, mark.alpha + (on ? dt : -dt) / MARK_FADE));
    if (!mark.target && !mark.alpha) {
      for (const sprite of mark.sprites) { scene.remove(sprite); sprite.material.dispose(); }
      marks.delete(key);
      continue;
    }
    const helper = mark.anchor && helpers.find((each) => each.id === mark.anchor);
    const at = mark.anchor ? helper?.model.position : character?.model.position;
    const top = mark.anchor ? helper?.top : character?.height;
    mark.sprites.forEach((sprite, i, { length }) => {
      sprite.visible = Boolean(at) && mark.alpha > 0;
      if (!sprite.visible) return;
      let size = mark.spec.size * (mark.anchor ? 0.85 : 1);
      let opacity = mark.alpha;
      let y = at.y + top;
      let side = mark.anchor ? 0 : 0.5;
      if (mark.kind === 'asleep') {
        const u = (mark.age / 2.7 + mark.seed + i / length) % 1;
        side = 0.38 + 0.6 * u + 0.05 * Math.sin(u * 2 * Math.PI);
        y += -0.3 + 0.55 * u;
        size *= 0.5 + 0.6 * u;
        opacity *= Math.min(1, u / 0.15, (1 - u) / 0.35);
        sprite.quaternion.copy(camera.quaternion).multiply(turn.setFromAxisAngle(axisZ, 0.25 * Math.sin(u * 2 * Math.PI + i)));
      } else {
        const t = mark.age + mark.seed * 9;
        sprite.quaternion.copy(camera.quaternion);
        y += (mark.anchor ? size * 0.6 : -0.15) + (mark.kind === 'waiting' ? 0.06 * Math.sin(t * 3.9) : 0);
        if (mark.kind === 'failed') size *= 1 + 0.35 * Math.exp(-mark.age * 5) * Math.sin(mark.age * 12) + 0.04 * Math.sin(t * 2.6);
      }
      sprite.position.copy(at).addScaledVector(screenRight, side);
      sprite.position.y = y;
      sprite.scale.setScalar(size);
      sprite.material.opacity = opacity;
    });
  }
}

// The manager's events, from the native side, which holds the token and the connection.
let sessions = new Map();
let reaction = null;
let walkingUntil = 0;
let changeTimer = 0;
const seen = new Set();

function react() {
  const now = Date.now();
  const previous = reaction?.mode;
  reaction = reactionTo([...sessions.values()], now);
  clearTimeout(changeTimer);
  if (reaction.nextChange !== null) changeTimer = setTimeout(react, Math.max(0, reaction.nextChange - now) + 50);

  // The Yard walks a session out of its door, and between its station and the plaza.
  const stepsOut = [...sessions.values()].some((session) => !seen.has(session.id) && arrives(session, now));
  for (const id of sessions.keys()) seen.add(id);
  const changedPlace = previous !== undefined && previous !== reaction.mode && (previous === 'rest' || reaction.mode === 'rest');
  if ((stepsOut || changedPlace) && character) walkThen();

  invoke('report', { message: `reaction: ${reaction.mode}, mark ${reaction.crewMark}, helpers ${reaction.helpers.map((helper) => helper.pose).join(' ') || 'none'}` });
  playMode();
  syncMarks();
  syncHelpers(reaction.helpers).catch((error) => { helperSignature = ''; invoke('report', { message: `helpers: ${error}` }); });
}

// A window that ignores the cursor gets no mouse events, so the cursor is polled instead, and the
// pixel under it read back straight after a render, while the drawing buffer still holds it.
let origin = await win.outerPosition();
let ignoring = false;
let dragging = false;
let probe = null; // cursor position in window pixels, waiting for the next render
const pixels = new Uint8Array((HIT_RADIUS * 2 + 1) ** 2 * 4);

function setIgnoring(value) {
  if (value === ignoring) return;
  ignoring = value;
  win.setIgnoreCursorEvents(value);
}

await win.onMoved(({ payload }) => { origin = payload; });

setInterval(async () => {
  if (dragging) return;
  const cursor = await cursorPosition();
  const x = cursor.x - origin.x;
  const y = cursor.y - origin.y;
  if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) setIgnoring(true);
  else probe = { x, y };
}, HIT_POLL_MS);

function readProbe() {
  const { x, y } = probe;
  probe = null;
  gl.readPixels(x - HIT_RADIUS, gl.drawingBufferHeight - 1 - y - HIT_RADIUS, HIT_RADIUS * 2 + 1, HIT_RADIUS * 2 + 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let hit = false;
  for (let i = 3; i < pixels.length && !hit; i += 4) hit = pixels[i] >= HIT_ALPHA;
  setIgnoring(!hit);
}

// Press and move drags the character.
let press = null;
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 0) press = { x: event.screenX, y: event.screenY };
});
canvas.addEventListener('pointermove', (event) => {
  if (!press || Math.hypot(event.screenX - press.x, event.screenY - press.y) < 4) return;
  press = null;
  dragging = true;
  win.startDragging().finally(() => { dragging = false; });
});
canvas.addEventListener('pointerup', () => { press = null; });

function render() {
  renderer.render(scene, camera);
  if (probe) readProbe();
}

const clock = new THREE.Clock();
let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - last < 1000 / FPS - 1) return;
  last = now;
  const dt = clock.getDelta();
  if (walkingUntil && performance.now() >= walkingUntil) {
    walkingUntil = 0;
    character.clip = null;
    playMode();
  }
  character?.mixer.update(dt);
  for (const helper of helpers) helper.mixer.update(dt);
  stepMarks(dt);
  render();
}

function storedSpirit() {
  try {
    const stored = Number.parseInt(localStorage.getItem(SPIRIT_KEY) ?? '', 10);
    return stored >= 0 && stored < 6 ? stored : DEFAULT_SPIRIT;
  } catch {
    return DEFAULT_SPIRIT;
  }
}

try {
  const { spirit } = await invoke('startup');
  reaction = reactionTo([], Date.now());
  await loadSpirit(spirit ?? storedSpirit());
  await listen('spirit', ({ payload }) => {
    try { localStorage.setItem(SPIRIT_KEY, String(payload)); } catch { /* it just won't be remembered */ }
    loadSpirit(payload).catch((error) => invoke('report', { message: `spirit: ${error}` }));
  });
  await listen('manager', ({ payload }) => {
    sessions = applyEvent(sessions, payload);
    if (payload.type === 'hello') for (const id of sessions.keys()) seen.add(id); // the Yard: no one steps out when a page opens
    react();
  });
  react();
  character.mixer.update(0);
  render();
  await win.show();
  requestAnimationFrame(frame);
  await invoke('connect_manager');
  invoke('report', { message: `ready: ${gl.getParameter(gl.VERSION)}` });
} catch (error) {
  invoke('report', { message: `failed: ${error?.stack ?? error}` });
}
