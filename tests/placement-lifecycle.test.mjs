import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companion, monitor } from './support/companion.mjs';

const savedAt = (fields = {}) => JSON.stringify({ v: 2, x: 1600, y: 800, role: 'rest', at: 'rest', ...fields });
const left = monitor(0, 0, 1920, 1040);

test('a disconnected restart stays at the saved resting slot, including after the manager grace', async () => {
  const saved = savedAt();
  const app = await companion({ saved });
  assert.deepEqual(app.positions, [{ x: 1600, y: 800 }]);
  for (let i = 0; i < 7; i++) {
    await app.emit('manager', { type: 'unreachable' });
    await app.advance(2000);
  }
  assert.deepEqual(app.positions, [{ x: 1600, y: 800 }]);
  assert.equal(app.saved(), saved);
  assert.ok(app.reports.some((message) => message.startsWith('ready: ')));
  assert.ok(!app.reports.some((message) => message.startsWith('failed: ')));
});

test('walking on staggered monitors keeps both slots at a visible fixed height', async () => {
  const app = await companion({ saved: savedAt({ role: 'work', at: 'work' }), monitors: [left, monitor(1920, 900, 1920, 1040)] });
  await app.emit('manager', { type: 'hello', sessions: [] });
  await app.advance(30000);
  assert.deepEqual(app.positions.at(-1), { x: 1380, y: 800 });
  assert.ok(app.positions.every(({ x, y }) => x >= 0 && x + 270 <= 1920 && y === 800));
  const saved = JSON.parse(app.saved());
  assert.deepEqual(saved, { v: 2, x: 1600, y: 800, role: 'work', at: 'rest' });
  const restarted = await companion({ saved: app.saved(), monitors: [left, monitor(1920, 900, 1920, 1040)] });
  assert.deepEqual(restarted.positions, [{ x: 1380, y: 800 }]);
});

test('the scale event during restore cannot undo the clamp on a high-DPI monitor', async () => {
  const saved = savedAt({ x: 3500, y: 100, role: 'work', at: 'work' });
  const app = await companion({ saved, monitors: [left, monitor(1920, 0, 1920, 2080, 2)] });
  assert.deepEqual(app.positions, [{ x: 3300, y: 100 }]);
  await app.emit('scale', { scaleFactor: 2, size: { width: 540, height: 480 } });
  await app.advance(30000);
  assert.ok(app.positions.every(({ x, y }) => x >= 1920 && x + 540 <= 3840 && y === 100), JSON.stringify(app.positions.at(-1)));
  assert.equal(app.saved(), saved);
});

test('a drop on a high-DPI monitor still stays exactly where it was put', async () => {
  const app = await companion({ saved: savedAt(), monitors: [left, monitor(1920, 0, 1920, 2080, 2)] });
  await app.emit('moved', { x: 3500, y: 100 });
  await app.advance(500);
  const moves = app.positions.length;
  await app.emit('scale', { scaleFactor: 2, size: { width: 540, height: 480 } });
  await app.advance(30000);
  assert.equal(app.positions.length, moves);
  assert.deepEqual(JSON.parse(app.saved()), { v: 2, x: 3500, y: 100, role: 'rest', at: 'rest' });
});
