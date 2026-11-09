import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VectorKeyframeTrack } from '../web/vendor/three.module.js';
import { GLTFLoader } from '../web/vendor/GLTFLoader.js';
import { characterProblem, loadCharacter, release } from '../web/characters.js';
import { clone } from '../web/vendor/SkeletonUtils.js';

globalThis.self ??= globalThis;
const bitmaps = [];
globalThis.createImageBitmap = async () => { const bitmap = { width: 1, height: 1, closed: 0, close() { this.closed += 1; } }; bitmaps.push(bitmap); return bitmap; };
const bytes = (name) => {
  const b = readFileSync(new URL(`./fixtures/characters/${name}.glb`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};
const parse = (name) => new GLTFLoader().parseAsync(bytes(name), '');

test('a World character draws', async () => {
  assert.equal(characterProblem(await parse('character')), null);
});

test('a character the Yard cannot stage is named as the Yard names it', async () => {
  assert.equal(characterProblem(await parse('missing_bone')), 'character.glb has no LeftFoot bone.');
  assert.equal(characterProblem(await parse('missing_clip')), 'character.glb has no done animation.');
});

test('a clip that walks away from its place is refused', async () => {
  const gltf = await parse('character');
  const walk = gltf.animations.find((clip) => clip.name === 'walk');
  const { x, y, z } = gltf.scene.getObjectByName('Hips').position;
  walk.tracks.push(new VectorKeyframeTrack('Hips.position', [0, walk.duration], [x, y, z, x + 5, y, z]));
  assert.match(characterProblem(gltf), /moves the character instead of playing in place \(walk\)/);
});

test('loading refuses a model it cannot read and leaves nothing half-loaded', async () => {
  class Loader extends GLTFLoader { loadAsync(url) { return this.parseAsync(bytes(url), ''); } }
  assert.equal(characterProblem(await loadCharacter(Loader, 'character')), null);
  await assert.rejects(loadCharacter(Loader, 'truncated'), /character.glb is damaged and can’t be drawn./);
  await assert.rejects(loadCharacter(Loader, 'missing_bone'), /has no LeftFoot bone/);
});

test('a released character closes each image it decoded, once, and keeps what a live copy still uses', async () => {
  const from = bitmaps.length;
  const gltf = await parse('character');
  const decoded = bitmaps.slice(from);
  assert.ok(decoded.length > 0, 'the fixture decodes an image');
  const live = clone(gltf.scene);
  release(gltf.scene, [live]);
  assert.deepEqual(decoded.map((bitmap) => bitmap.closed), decoded.map(() => 0));
  release(live);
  assert.deepEqual(decoded.map((bitmap) => bitmap.closed), decoded.map(() => 1));
});

test('a model refused by the draw check is released', async () => {
  class Loader extends GLTFLoader { loadAsync(url) { return this.parseAsync(bytes(url), ''); } }
  const from = bitmaps.length;
  await assert.rejects(loadCharacter(Loader, 'missing_bone'));
  const decoded = bitmaps.slice(from);
  assert.ok(decoded.length > 0);
  assert.ok(decoded.every((bitmap) => bitmap.closed === 1));
});
