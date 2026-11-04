import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placesFrom, stepToward } from '../web/places.js';

const area = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } };

test('working on the right of the screen, it rests to the left', () => {
  assert.deepEqual(placesFrom(1600, 'work', 220, 270, area), { home: 1600, rest: 1380 });
});

test('working on the left of the screen, it rests to the right', () => {
  assert.deepEqual(placesFrom(100, 'pause', 220, 270, area), { home: 100, rest: 320 });
});

test('put down while resting, it stays there and works a walk away', () => {
  assert.deepEqual(placesFrom(1600, 'rest', 220, 270, area), { home: 1380, rest: 1600 });
});

test('the side is worked out on the monitor it is on', () => {
  const second = { position: { x: 1920, y: 0 }, size: { width: 1920, height: 1040 } };
  assert.deepEqual(placesFrom(2000, 'work', 220, 270, second), { home: 2000, rest: 2220 });
});

test('a step moves at speed and stops on the target', () => {
  assert.equal(stepToward(100, 200, 30, 0.5), 115);
  assert.equal(stepToward(200, 100, 30, 0.5), 185);
  assert.equal(stepToward(100, 105, 30, 0.5), 105);
  assert.equal(stepToward(100, 100, 30, 0.5), 100);
});
