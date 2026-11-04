// Copies Three.js and Grove's six spirits into web/, so the app needs no bundler and no art download.
// Run with agent-guild checked out beside this repo, or pass its path.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const guild = path.resolve(process.argv[2] ?? '../agent-guild', 'web/yard/assets');
const three = 'node_modules/three';
mkdirSync('web/vendor', { recursive: true });
mkdirSync('web/assets/maps', { recursive: true });

for (const file of ['three.module.js', 'three.core.js']) cpSync(`${three}/build/${file}`, `web/vendor/${file}`);
cpSync(`${three}/LICENSE`, 'web/vendor/LICENSE.three');
// Without a bundler or an import map, the example modules import Three.js by relative path.
for (const [from, to] of [['loaders/GLTFLoader.js', 'GLTFLoader.js'], ['utils/BufferGeometryUtils.js', 'BufferGeometryUtils.js'], ['utils/SkeletonUtils.js', 'SkeletonUtils.js']]) {
  const source = readFileSync(`${three}/examples/jsm/${from}`, 'utf8')
    .replaceAll(/from ['"]three['"]/g, "from './three.module.js'")
    .replaceAll(/from ['"]\.\.\/utils\/(\w+\.js)['"]/g, "from './$1'");
  writeFileSync(`web/vendor/${to}`, source);
}
// The Yard's staging logic, unchanged: its golden vectors in agent-guild pin this file.
cpSync(path.resolve(guild, '../model.mjs'), 'web/vendor/model.mjs');
// Grove's cast, as WORLDS.grove names it: its spirits, its familiars for agents and its drones for shells.
const models = [...[0, 1, 2, 3, 4, 5].map((n) => `spirit_${n}`), ...[0, 1, 2, 3].flatMap((n) => [`familiar_${n}`, `drone_${n}`])];
for (const model of models) cpSync(`${guild}/${model}.glb`, `web/assets/${model}.glb`);
for (const file of readdirSync(`${guild}/maps`).filter((name) => models.includes(name.split('-')[0]))) {
  cpSync(`${guild}/maps/${file}`, `web/assets/maps/${file}`);
}
