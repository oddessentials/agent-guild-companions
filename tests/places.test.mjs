import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placesFor, readPlacement, screenFor, stepToward } from '../web/places.js';

const size = { width: 270, height: 240 };
const monitor = (x, y, width, height, scaleFactor = 1) => ({ workArea: { position: { x, y }, size: { width, height } }, scaleFactor });
const left = monitor(0, 0, 1920, 1040);
const right = monitor(1920, 0, 1920, 1040);

test('working on the right of the screen, it rests to the left', () => {
  assert.deepEqual(placesFor({ x: 1600, y: 800, role: 'work' }, size, 220, [left], false), { work: 1600, rest: 1380, y: 800 });
});

test('working on the left of the screen, it rests to the right', () => {
  assert.deepEqual(placesFor({ x: 100, y: 800, role: 'work' }, size, 220, [left], false), { work: 100, rest: 320, y: 800 });
});

test('put down while resting, it rests exactly there and works a walk away', () => {
  assert.deepEqual(placesFor({ x: 1600, y: 800, role: 'rest' }, size, 220, [left], false), { work: 1380, rest: 1600, y: 800 });
});

test('put down on a second monitor, it walks toward that monitor\'s middle, in either role', () => {
  assert.deepEqual(placesFor({ x: 2000, y: 100, role: 'work' }, size, 220, [left, right], false), { work: 2000, rest: 2220, y: 100 });
  assert.deepEqual(placesFor({ x: 2000, y: 100, role: 'rest' }, size, 220, [left, right], false), { work: 2220, rest: 2000, y: 100 });
  assert.deepEqual(placesFor({ x: 3500, y: 100, role: 'work' }, size, 220, [left, right], false), { work: 3500, rest: 3280, y: 100 });
});

test('with staggered monitors, both places stay on the monitor it was put on, at its height', () => {
  const lower = monitor(1920, 900, 1920, 1040);
  assert.deepEqual(placesFor({ x: 1600, y: 800, role: 'work' }, size, 220, [left, lower], true), { work: 1600, rest: 1380, y: 800 });
  assert.deepEqual(placesFor({ x: 1650, y: 800, role: 'rest' }, size, 220, [left, lower], true), { work: 1430, rest: 1650, y: 800 });
});

test('a monitor too narrow for the walk shortens it rather than leave the monitor', () => {
  const narrow = monitor(0, 0, 400, 1040);
  assert.deepEqual(placesFor({ x: 100, y: 0, role: 'work' }, size, 220, [narrow], false), { work: 100, rest: 0, y: 0 });
  assert.deepEqual(placesFor({ x: 130, y: 0, role: 'rest' }, size, 220, [narrow], false), { work: 0, rest: 130, y: 0 });
  assert.deepEqual(placesFor({ x: 0, y: 0, role: 'work' }, size, 220, [monitor(0, 0, 200, 1040)], false), { work: 0, rest: 0, y: 0 });
});

test('the walk and the window follow the monitor\'s scale', () => {
  const sharp = monitor(0, 0, 3840, 2080, 2);
  assert.deepEqual(placesFor({ x: 3000, y: 1000, role: 'work' }, size, 220, [sharp], true), { work: 3000, rest: 2560, y: 1000 });
  assert.deepEqual(placesFor({ x: 3500, y: 1800, role: 'work' }, size, 220, [sharp], true), { work: 3300, rest: 2860, y: 1600 });
});

test('a placement on a monitor that has gone is shown on the nearest one, and left as it was', () => {
  const placement = { x: 2000, y: 100, role: 'work' };
  assert.deepEqual(placesFor(placement, size, 220, [left], true), { work: 1650, rest: 1430, y: 100 });
  assert.deepEqual(placement, { x: 2000, y: 100, role: 'work' });
  assert.deepEqual(placesFor(placement, size, 220, [left, right], true), { work: 2000, rest: 2220, y: 100 });
});

test('only a restore clamps; a drop stays exactly where it was put', () => {
  assert.deepEqual(placesFor({ x: 1800, y: 900, role: 'work' }, size, 220, [left], false), { work: 1800, rest: 1580, y: 900 });
  assert.deepEqual(placesFor({ x: 1800, y: 900, role: 'work' }, size, 220, [left], true), { work: 1650, rest: 1430, y: 800 });
});

test('with no monitors known, it stays where it is', () => {
  assert.deepEqual(placesFor({ x: 5, y: 6, role: 'rest' }, size, 220, [], true), { work: 5, rest: 5, y: 6 });
  assert.equal(screenFor({ x: 5, y: 6 }, size, []), null);
});

test('a saved record is read as a placement, a spot from before placements, or left alone', () => {
  assert.equal(readPlacement(null), null);
  assert.deepEqual(readPlacement('{"x":4446,"y":1200}'), { legacy: { x: 4446, y: 1200 } });
  assert.deepEqual(readPlacement('{"v":2,"x":4446,"y":1200,"role":"rest","at":"work"}'), { placement: { x: 4446, y: 1200, role: 'rest' }, at: 'work' });
  for (const text of ['{"v":3,"x":1,"y":2}', '{"v":2,"x":1,"y":2,"role":"home","at":"rest"}', '{"x":"a"}', 'not json']) {
    assert.deepEqual(readPlacement(text), { unknown: true }, text);
  }
});

test('a step moves at speed and stops on the target', () => {
  assert.equal(stepToward(100, 200, 30, 0.5), 115);
  assert.equal(stepToward(200, 100, 30, 0.5), 185);
  assert.equal(stepToward(100, 105, 30, 0.5), 105);
  assert.equal(stepToward(100, 100, 30, 0.5), 100);
});
