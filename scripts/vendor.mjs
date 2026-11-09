// Copies Three.js and Grove's six spirits into web/, so the app needs no bundler and no art download.
// Run with agent-guild checked out beside this repo, or pass its path. --check only compares the vendored
// model.mjs with agent-guild's committed one, and exits 1 if they differ.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args.find((arg) => arg !== '--check') ?? '../agent-guild');
const guild = path.join(root, 'web/yard/assets');
const MODEL = 'web/yard/model.mjs';
const SOURCE = 'web/vendor/model.source.json';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const git = (...command) => execFileSync('git', ['-C', root, ...command], { maxBuffer: 16 * 1024 * 1024 });
const upstream = { commit: git('rev-parse', 'HEAD').toString().trim(), model: git('show', `HEAD:${MODEL}`) };

if (args.includes('--check')) {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const vendored = sha256(readFileSync('web/vendor/model.mjs'));
  const latest = sha256(upstream.model);
  if (vendored !== source.sha256) console.log(`web/vendor/model.mjs was changed after vendoring from ${source.commit}.`);
  if (latest !== vendored) console.log(`agent-guild ${upstream.commit} has a different model.mjs than the one vendored from ${source.commit}. Run npm run vendor.`);
  if (vendored === source.sha256 && latest === vendored) console.log(`web/vendor/model.mjs matches agent-guild ${upstream.commit}.`);
  process.exit(vendored === source.sha256 && latest === vendored ? 0 : 1);
}

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
// The tray shows Agent Guild's shield.
cpSync(path.resolve(guild, '../../brand/favicon.png'), 'src-tauri/icons/tray.png');
// The Yard's staging logic, unchanged: its golden vectors in agent-guild pin this file.
writeFileSync('web/vendor/model.mjs', upstream.model);
writeFileSync(SOURCE, `${JSON.stringify({ repository: 'https://github.com/oddessentials/agent-guild', path: MODEL, commit: upstream.commit, sha256: sha256(upstream.model) }, null, 2)}
`);
// Grove's cast, as WORLDS.grove names it: its spirits, its familiars for agents and its drones for shells.
const models = [...[0, 1, 2, 3, 4, 5].map((n) => `spirit_${n}`), ...[0, 1, 2, 3].flatMap((n) => [`familiar_${n}`, `drone_${n}`])];
for (const model of models) cpSync(`${guild}/${model}.glb`, `web/assets/${model}.glb`);
for (const file of readdirSync(`${guild}/maps`).filter((name) => models.includes(name.split('-')[0]))) {
  cpSync(`${guild}/maps/${file}`, `web/assets/maps/${file}`);
}
// The Yard's 2048 px textures cost about 150 MB more here and look no better on a character this small.
execFileSync('python', ['-I', 'scripts/shrink_maps.py', 'web/assets/maps', '512'], { stdio: 'inherit' });
