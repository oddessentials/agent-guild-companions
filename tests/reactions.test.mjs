import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, mergeSessions, reactionTo } from '../web/reactions.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const session = (id, fields = {}) => ({ id, status: 'running', activity: 'quiet', lastOutputAt: ago(1000), agents: [], shells: [], ...fields });

test('no sessions: the character rests, asleep', () => {
  const reaction = reactionTo([], NOW);
  assert.equal(reaction.mode, 'rest');
  assert.equal(reaction.crewMark, 'asleep');
  assert.deepEqual(reaction.helpers, []);
});

test('it works while any session works', () => {
  assert.equal(reactionTo([session('a', { lastOutputAt: ago(99999) }), session('b', { activity: 'active' })], NOW).mode, 'work');
});

test('quiet sessions pause for 20 s from the latest output, then rest', () => {
  assert.equal(reactionTo([session('a', { lastOutputAt: ago(99999) }), session('b', { lastOutputAt: ago(19000) })], NOW).mode, 'pause');
  const resting = reactionTo([session('a', { lastOutputAt: ago(21000) })], NOW);
  assert.equal(resting.mode, 'rest');
  assert.equal(resting.crewMark, 'asleep');
});

test('it schedules the change to rest', () => {
  assert.equal(reactionTo([session('a', { lastOutputAt: ago(19000) })], NOW).nextChange, NOW + 1000);
});

test('helpers come from every running session, with the Yard poses and ids kept apart', () => {
  const reaction = reactionTo([
    session('a', { agents: [{ id: 'x', name: 'one', status: 'working' }], shells: [{ id: 's', kind: 'shell' }] }),
    session('b', { agents: [{ id: 'x', name: 'two', status: 'waiting' }], shells: [{ id: 's', kind: 'monitor' }] }),
  ], NOW);
  assert.deepEqual(reaction.helpers.map((helper) => [helper.id, helper.pose, helper.shell]), [
    ['a:x', 'working', false], ['b:x', 'waiting', false], ['a:s', 'working', true], ['b:s', 'idle', true],
  ]);
  assert.deepEqual(reaction.helperMarks, ['b:x']);
});

test('a helper past the shown six still marks the character as waiting', () => {
  const agents = Array.from({ length: 7 }, (_, n) => ({ id: `${n}`, name: `${n}`, status: n === 6 ? 'waiting' : 'working' }));
  assert.equal(reactionTo([session('a', { agents })], NOW).crewMark, 'waiting');
});

test('all ended: it shows how the last one ended', () => {
  const ended = (id, exitedAt, exitCode) => session(id, { status: 'exited', exitedAt: ago(exitedAt), exitCode });
  const clean = reactionTo([ended('a', 5000, 1), ended('b', 1000, 0)], NOW);
  assert.equal(clean.mode, 'done');
  assert.equal(mergeSessions([ended('a', 5000, 1), ended('b', 1000, 0)]).exitCode, 0);
});

test('a crash is marked even while another session runs', () => {
  const reaction = reactionTo([session('a', { activity: 'active' }), session('b', { status: 'exited', exitCode: 3 })], NOW);
  assert.equal(reaction.mode, 'work');
  assert.equal(reaction.crewMark, 'failed');
});

test('a signal counts as a crash and a clean exit does not', () => {
  assert.equal(reactionTo([session('b', { status: 'exited', signal: 'SIGKILL' })], NOW).crewMark, 'failed');
  assert.equal(reactionTo([session('b', { status: 'exited', exitCode: 0 })], NOW).crewMark, 'exited');
});

test('events keep the session list', () => {
  let sessions = applyEvent(new Map(), { type: 'hello', sessions: [session('a')] });
  sessions = applyEvent(sessions, { type: 'session.created', session: session('b') });
  sessions = applyEvent(sessions, { type: 'session.updated', session: session('a', { activity: 'active' }) });
  assert.equal(sessions.get('a').activity, 'active');
  sessions = applyEvent(sessions, { type: 'session.removed', sessionId: 'b' });
  assert.deepEqual([...sessions.keys()], ['a']);
  assert.equal(applyEvent(sessions, { type: 'disconnected' }).size, 0);
});
