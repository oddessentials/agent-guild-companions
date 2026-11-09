import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as cloneSkeleton } from './vendor/SkeletonUtils.js';
import { clipFor, hash, SHOWN_HELPERS, STAGING, WORLDS, yardExtras } from './vendor/model.mjs';
import { loadCharacter, release } from './characters.js';
import { placesFor, readPlacement, stepToward } from './places.js';
import { applyEvent, followManager, placeFor, reactionTo } from './reactions.js';

const { convertFileSrc, invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { PhysicalPosition } = window.__TAURI__.dpi;
const { availableMonitors, getCurrentWindow } = window.__TAURI__.window;
const win = getCurrentWindow();
const step = (message) => invoke('report', { message: `start: ${message}` });
step('script loaded');

const FPS = 30;
const HIT_ALPHA = 32; // of 255: anything fainter than this is not the character
const HIT_RADIUS = 2; // pixels round the cursor, so the outline is not a one-pixel target
const FIT_SAMPLES = 4; // poses sampled from each clip to fit the camera
const VIEW_DIRECTION = new THREE.Vector3(0.28, 0.32, 1); // a little above and to one side
const FADE = 0.3; // seconds between clips, as in the Yard
const TURN = 7; // radians a second, as in the Yard
const SPIRIT = 3; // the bird
const SPIRIT_KEY = 'spirit';
const CHARACTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPOT_KEY = 'spot'; // where it was last put
const REST_DISTANCE = 220; // CSS pixels between where it works and where it rests
const DRAG_SETTLE_MS = 400; // no walking this soon after someone moved the window
const WALK_ECHO = 12; // pixels a move report may lag behind a walk and still be the walk's own

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

let character = null; // { n, model, mixer, clips, action, clip, height, speed, heading }
let spiritRequest = 0;
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
  if (!character || !reaction || walking) return;
  if (character.clip && character.clipMode === reaction.mode && character.clip !== 'walk') return;
  character.clipMode = reaction.mode;
  character.clipCount = 0;
  crossTo(clipFor(reaction.id, reaction.mode, 0), THREE.LoopOnce);
}

function nextClip() {
  if (!reaction || walking) return;
  character.clipCount += 1;
  const name = clipFor(reaction.id, character.clipMode, character.clipCount);
  if (name === character.clip) character.action.reset().play();
  else crossTo(name, THREE.LoopOnce);
}

const added = (n) => typeof n === 'string';
const characterUrl = (id) => convertFileSrc(id, 'character');

async function loadSpirit(n) {
  const request = ++spiritRequest;
  const gltf = added(n) ? await loadCharacter(GLTFLoader, characterUrl(n)) : await asset(`${GROVE.characters}${n}`);
  if (request !== spiritRequest) {
    if (added(n)) release(gltf.scene, [character?.model]);
    return;
  }
  const heading = character?.heading ?? 0;
  if (character) {
    scene.remove(character.model);
    character.mixer.stopAllAction();
    character.mixer.uncacheRoot(character.model);
    if (added(character.n)) release(character.model, [gltf.scene]);
  }
  const model = cloneSkeleton(gltf.scene);
  let extras = null;
  model.traverse((node) => {
    if (node.isMesh) node.frustumCulled = false;
    if (node.userData?.yard) extras = node.userData.yard;
  });
  const yard = yardExtras(extras, 'character');
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations;
  const { height } = yard;
  fitCamera(model, mixer, clips, height);
  mixer.stopAllAction();
  scene.add(model);
  mixer.addEventListener('finished', nextClip);
  // The model's own stride and cycle, so its planted feet do not slide as the window moves.
  const speed = yard.stride / yard.cycle;
  character = { n, model, mixer, clips, action: null, clip: null, clipMode: null, clipCount: 0, height, speed, heading };
  model.rotation.y = heading;
  if (walking) crossTo('walk', THREE.LoopRepeat);
  else playMode();
}

function savedSpirit() {
  try {
    const saved = localStorage.getItem(SPIRIT_KEY);
    if (CHARACTER_ID.test(saved)) return saved;
    const n = Number(saved);
    return saved !== null && Number.isInteger(n) && n >= 0 && n < 6 ? n : SPIRIT;
  } catch { return SPIRIT; }
}

const shown = () => invoke('spirit_shown', { id: String(character.n) });

async function chooseSpirit(n) {
  if (n === character?.n) spiritRequest += 1;
  else await loadSpirit(n);
  if (character?.n !== n) return;
  try { localStorage.setItem(SPIRIT_KEY, String(n)); } catch {}
  shown();
}

function unavailable(n, error) {
  invoke('report', { message: `spirit: ${error?.message ?? error}` });
  if (added(n)) invoke('character_unavailable', { id: n, problem: String(error?.message ?? error) });
}

async function checkCharacter(token) {
  let problem = null;
  try { release((await loadCharacter(GLTFLoader, characterUrl(`check-${token}`))).scene, [character?.model]); } catch (error) { problem = error.message; }
  await invoke('character_checked', { token, problem });
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
    const helper = { id: agent.id, model, mixer: new THREE.AnimationMixer(model), clips: source.animations, action: null, top: (yard?.height ?? 1) * HELPER_SCALE, offset, pose: agent.pose, moving: false };
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
    const on = mark.target && !(mark.kind === 'asleep' && walking) ? 1 : 0;
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
let link = { lostSince: null, gone: false };
let known = false;
let reaction = null;
let walking = false;
let changeTimer = 0;

function react() {
  const now = Date.now();
  reaction = reactionTo([...sessions.values()], now);
  clearTimeout(changeTimer);
  if (reaction.nextChange !== null) changeTimer = setTimeout(react, Math.max(0, reaction.nextChange - now) + 50);
  invoke('report', { message: `reaction: ${reaction.mode}, mark ${reaction.crewMark}, helpers ${reaction.helpers.map((helper) => helper.pose).join(' ') || 'none'}` });
  playMode();
  syncMarks();
  syncHelpers(reaction.helpers).catch((error) => { helperSignature = ''; invoke('report', { message: `helpers: ${error}` }); });
}

// A window that ignores the cursor gets no mouse events, so the cursor is polled instead, and the
// pixel under it read back straight after a render, while the drawing buffer still holds it.
step('reading the window');
const origin = await win.outerPosition();
let ignoring = false;
let dragging = false;
let probe = null; // cursor position in window pixels, waiting for the next render
const pixels = new Uint8Array((HIT_RADIUS * 2 + 1) ** 2 * 4);

function setIgnoring(value) {
  if (value === ignoring) return;
  ignoring = value;
  win.setIgnoreCursorEvents(value);
}

// Walking: the window itself travels between the two places, as the Yard's characters walk between
// station and plaza. pos is exact; the window only goes to whole pixels, sent is where it was last told.
let pos = { x: origin.x, y: origin.y };
let sent = { x: origin.x, y: origin.y };
const size = { width: window.innerWidth, height: window.innerHeight };
let placement = null; // { x, y, role }: where it was put, and as which place; only a drop changes it
let legacy = null;
let at = 'rest'; // the place it last stood at
let keepSaved = false; // a saved record this version cannot read stays as it was
let places = null;
let clampPlacement = true; // restored places stay on screen; only a new drop may leave them partly off
let moves = 0;
let dropping = 0;
let dropTimer = 0;

const monitors = () => availableMonitors().catch(() => []);
const slot = () => (known ? placeFor(reaction.mode) : at);

function save() {
  if (keepSaved) return;
  try { localStorage.setItem(SPOT_KEY, JSON.stringify({ v: 2, ...placement, at })); } catch { /* it just won't be remembered */ }
}

async function drop(move) {
  const next = { x: pos.x, y: pos.y, role: slot() };
  const shown = await monitors();
  if (move !== dropping) return;
  placement = next;
  clampPlacement = false;
  places = placesFor(placement, size, REST_DISTANCE, shown, false);
  at = placement.role;
  dropping = 0;
  save();
}

await win.onMoved(({ payload }) => {
  const off = Math.hypot(payload.x - sent.x, payload.y - sent.y);
  if (off <= (walking ? WALK_ECHO : 0)) return;
  // Not our own walk, so someone moved it: where it was put is now its place.
  pos = { x: payload.x, y: payload.y };
  sent = { x: payload.x, y: payload.y };
  if (walking) {
    walking = false;
    character.clip = null;
    playMode();
  }
  const move = ++moves;
  dropping = move;
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => drop(move), DRAG_SETTLE_MS);
});

await win.onScaleChanged(async () => {
  if (!placement) return;
  const shown = await monitors();
  if (placement && !dropping) places = placesFor(placement, size, REST_DISTANCE, shown, clampPlacement);
});

/** Back at the place it last stood, shown wholly on a screen without changing what was saved. */
async function restore() {
  let saved;
  try { saved = readPlacement(localStorage.getItem(SPOT_KEY)); } catch { saved = { unknown: true }; }
  if (saved?.unknown) keepSaved = true;
  if (!saved?.placement && !saved?.legacy) return;
  const shownAt = placesFor(saved.placement ?? { ...saved.legacy, role: 'work' }, size, REST_DISTANCE, await monitors(), true);
  if (saved.placement) {
    ({ placement, at } = saved);
    places = shownAt;
  } else legacy = saved.legacy;
  const spot = { x: shownAt[saved.placement ? at : 'work'], y: shownAt.y };
  pos = { ...spot };
  sent = { ...spot };
  await win.setPosition(new PhysicalPosition(spot.x, spot.y));
}

async function heard() {
  if (known) return;
  known = true;
  if (placement || dropping) return;
  const next = { ...(legacy ?? { x: pos.x, y: pos.y }), role: slot() };
  const shown = await monitors();
  if (placement || dropping) return;
  placement = next;
  places = placesFor(placement, size, REST_DISTANCE, shown, true);
  at = placement.role;
  save();
}

const angleTo = (from, to) => {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const turnToward = (from, to, dt) => {
  const turn = angleTo(from, to);
  return from + Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt);
};

// The Yard's advance and its helpers' trailing (renderer.js).
function advance(dt) {
  if (!character || !places) return;
  const place = slot();
  const target = places[place];
  let moved = 0; // metres the character covered this frame
  if (!dropping && pos.x !== target) {
    if (!walking) {
      walking = true;
      crossTo('walk', THREE.LoopRepeat);
    }
    const pixelsPerMetre = gl.drawingBufferHeight / (camera.top - camera.bottom);
    const next = stepToward(pos.x, target, character.speed * pixelsPerMetre, dt);
    moved = (next - pos.x) / pixelsPerMetre;
    pos.x = next;
    const whole = Math.round(next);
    if (whole !== sent.x) {
      sent.x = whole;
      win.setPosition(new PhysicalPosition(whole, sent.y));
    }
    if (next === target) {
      walking = false;
      character.clip = null;
      playMode();
    }
  }
  if (!walking && !dropping && pos.x === target && at !== place) {
    at = place;
    save();
  }
  let want = place === 'rest' ? 0 : STAGING.stationFace;
  // Straight along the screen, the way the window goes, which the camera's angle turns a little from world X.
  if (walking) want = Math.atan2(Math.sign(target - pos.x) * screenRight.x, Math.sign(target - pos.x) * screenRight.z);
  character.heading = turnToward(character.heading, want, dt);
  character.model.rotation.y = character.heading;

  // Helpers stay where they are in the world as the window moves, then catch up.
  const pull = 1 - Math.exp(-4 * dt);
  for (const helper of helpers) {
    const p = helper.model.position;
    p.addScaledVector(screenRight, -moved);
    const dx = helper.offset.x - p.x;
    const dz = helper.offset.z - p.z;
    const far = Math.hypot(dx, dz);
    p.x += dx * pull;
    p.z += dz * pull;
    helper.model.rotation.y = far > 0.05 ? Math.atan2(dx, dz) : turnToward(helper.model.rotation.y, 0, dt);
    const moving = far > 0.08;
    if (moving !== helper.moving) {
      helper.moving = moving;
      helperClip(helper, moving ? 'move' : helper.pose);
    }
  }
}

setIgnoring(true);
await listen('cursor', ({ payload }) => {
  if (dragging) return;
  if (!payload || payload.x >= gl.drawingBufferWidth || payload.y >= gl.drawingBufferHeight) {
    probe = null;
    setIgnoring(true);
  } else probe = { x: payload.x, y: payload.y };
});

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
function frame() {
  setTimeout(frame, 1000 / FPS);
  if (document.hidden) return;
  const dt = clock.getDelta();
  advance(dt);
  character?.mixer.update(dt);
  for (const helper of helpers) helper.mixer.update(dt);
  stepMarks(dt);
  render();
}

try {
  reaction = reactionTo([], Date.now());
  step('loading the spirit');
  const saved = savedSpirit();
  try { await loadSpirit(saved); } catch (error) {
    if (!added(saved)) throw error;
    unavailable(saved, error);
    await loadSpirit(SPIRIT);
  }
  step('placing the window');
  await restore();
  await listen('manager', ({ payload }) => {
    const wasGone = link.gone;
    link = followManager(link, payload, Date.now());
    if (payload.type === 'unreachable') {
      if (!link.gone || wasGone) return;
      sessions = new Map();
      invoke('report', { message: 'manager: gone' });
    } else sessions = applyEvent(sessions, payload);
    react();
    if (payload.type === 'hello' || link.gone) heard();
  });
  await listen('spirit', ({ payload }) => {
    chooseSpirit(payload).catch((error) => {
      unavailable(payload, error);
      shown();
    });
  });
  await listen('check-character', ({ payload }) => checkCharacter(payload));
  await listen('removed', ({ payload }) => {
    if (character.n === payload) chooseSpirit(SPIRIT).catch((error) => unavailable(SPIRIT, error));
  });
  shown();
  react();
  step('drawing');
  character.mixer.update(0);
  render();
  step('showing the window');
  await win.show();
  frame();
  await invoke('connect_manager');
  invoke('report', { message: `ready: ${gl.getParameter(gl.VERSION)}` });
} catch (error) {
  invoke('report', { message: `failed: ${error?.stack ?? error}` });
}
