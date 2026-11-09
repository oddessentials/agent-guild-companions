import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VectorKeyframeTrack } from '../web/vendor/three.module.js';
import { GLTFLoader } from '../web/vendor/GLTFLoader.js';
import { characterProblem, loadCharacter } from '../web/characters.js';

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
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
