import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitmaps, companion } from './support/companion.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'e1b2c3d4-0000-4000-8000-000000000001';
const url = (path) => `character://localhost/${path}`;
const shownAs = (app) => app.calls.filter(([command]) => command === 'spirit_shown').at(-1)?.[1].id;
const commands = (app, name) => JSON.parse(JSON.stringify(app.calls.filter(([command]) => command === name).map(([, data]) => data)));
const skinnedIn = (scene) => { let found = 0; scene.traverse((node) => { if (node.isSkinnedMesh && node.visible) found += 1; }); return found; };

test('a spirit chosen before characters could be added is still shown, and its choice kept', async () => {
  const app = await companion({ spirit: '1' });
  assert.equal(shownAs(app), '1');
  assert.equal(app.stored('spirit'), '1');
});

test('an added character chosen before a restart comes back, drawn with its own rig', async () => {
  const app = await companion({ spirit: ID, models: { [url(ID)]: 'character' } });
  assert.equal(shownAs(app), ID);
  assert.ok(skinnedIn(app.drawn.at(-1)) > 0, 'the World character is in the drawn scene');
  assert.deepEqual(commands(app, 'character_unavailable'), []);
  assert.ok(!app.reports.some((message) => message.startsWith('failed: ')));
});

test('a missing or damaged added character falls back to the bird without changing the saved choice', async () => {
  for (const models of [{}, { [url(ID)]: 'missing_bone' }]) {
    const app = await companion({ spirit: ID, models });
    assert.equal(shownAs(app), '3');
    assert.equal(app.stored('spirit'), ID);
    assert.deepEqual(commands(app, 'character_unavailable').map(({ id }) => id), [ID]);
    assert.ok(app.reports.some((message) => message.startsWith('ready: ')));
  }
});

test('choosing a character that cannot be drawn keeps the one on show and its saved choice', async () => {
  const app = await companion({ spirit: '2', models: { [url(ID)]: 'missing_clip' } });
  await app.emit('spirit', ID);
  assert.equal(shownAs(app), '2');
  assert.equal(app.stored('spirit'), '2');
  assert.match(commands(app, 'character_unavailable')[0].problem, /has no done animation/);
});

test('each staged import is answered with its own token and its own verdict', async () => {
  const app = await companion({ models: { [url(`check-${TOKEN}`)]: 'character', [url(`check-${OTHER}`)]: 'missing_bone' } });
  await app.emit('check-character', TOKEN);
  await app.emit('check-character', OTHER);
  await app.emit('check-character', ID);
  assert.deepEqual(commands(app, 'character_checked'), [
    { token: TOKEN, problem: null },
    { token: OTHER, problem: 'character.glb has no LeftFoot bone.' },
    { token: ID, problem: 'character.glb is damaged and can’t be drawn.' },
  ]);
  assert.equal(shownAs(app), '3', 'checking never changes what is shown');
});

test('removing the character on show brings back the bird; removing another changes nothing', async () => {
  const app = await companion({ spirit: ID, models: { [url(ID)]: 'character' } });
  await app.emit('removed', OTHER);
  assert.equal(shownAs(app), ID);
  await app.emit('removed', ID);
  assert.equal(shownAs(app), '3');
  assert.equal(app.stored('spirit'), '3');
});

test('every added character that is checked, outrun or replaced releases its images; bundled spirits keep theirs', async () => {
  const from = bitmaps.length;
  const app = await companion({ spirit: ID, models: { [url(ID)]: 'character', [url(OTHER)]: 'character', [url(`check-${TOKEN}`)]: 'character' } });
  const open = () => bitmaps.slice(from).filter((bitmap) => bitmap.source === 'added' && !bitmap.closed).length;
  const shownImages = open();
  assert.ok(shownImages > 0, 'the character on show holds its images');
  await app.emit('check-character', TOKEN);
  assert.equal(open(), shownImages, 'a checked import releases its own copy and not the one on show');
  const outrun = app.emit('spirit', OTHER);
  await app.emit('spirit', 2);
  await outrun;
  assert.equal(shownImages, bitmaps.slice(from).filter((bitmap) => bitmap.source === 'added').length / 3, 'three copies were decoded');
  assert.equal(open(), 0, 'the outrun load and the replaced character are released');
  assert.equal(shownAs(app), '2');
  assert.ok(!commands(app, 'spirit_shown').some(({ id }) => id === OTHER), 'the outrun character was never shown');
  await app.emit('spirit', 1);
  assert.ok(bitmaps.slice(from).filter((bitmap) => bitmap.source === 'bundled').every((bitmap) => !bitmap.closed));
  assert.ok(bitmaps.slice(from).every((bitmap) => bitmap.closed <= 1), 'nothing is closed twice');
});
