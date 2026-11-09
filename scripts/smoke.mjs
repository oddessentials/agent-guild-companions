// Starts the built app on a clean machine and checks that it draws its first frame and keeps running.
// With no manager to find, it should simply rest. A screenshot goes beside it for a person to look at.
//   node scripts/smoke.mjs <app executable> <screenshot.png>
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const [executable, screenshot] = process.argv.slice(2);
if (!executable || !screenshot) throw new Error('usage: smoke.mjs <app executable> <screenshot.png>');

const READY_SECONDS = 120; // runners draw in software, and the first load is slow
const SETTLE_SECONDS = 8; // long enough to crash, and for a clip to be under way
const STEP_SECONDS = 20;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const home = mkdtempSync(path.join(tmpdir(), 'companion-smoke-'));
const apps = [];
let manager = null;

function start(name) {
  const app = { name, log: '', exited: null };
  app.child = spawn(executable, [], { env: { ...process.env, AGENT_GUILD_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
  app.child.stderr.on('data', (chunk) => { app.log += chunk; });
  app.child.on('exit', (code, signal) => { app.exited = { code, signal }; });
  app.child.on('error', (error) => { app.exited = { error: String(error) }; });
  apps.push(app);
  return app;
}

const logs = () => apps.map((app) => `--- ${app.name}\n${app.log}`).join('\n');

function capture() {
  const script = 'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; '
    + '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i = New-Object System.Drawing.Bitmap($b.Width, $b.Height); '
    + '[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); '
    + `$i.Save('${screenshot.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    : spawnSync('screencapture', ['-x', screenshot], { encoding: 'utf8' });
  // A screenshot is for people to look at: its failure says nothing about the app.
  if (result.status !== 0) console.log(`::warning::No screenshot: ${result.stderr || result.error}`);
}

async function cleanUp() {
  for (const app of apps) if (!app.exited) app.child.kill();
  const deadline = Date.now() + STEP_SECONDS * 1000;
  while (apps.some((app) => !app.exited) && Date.now() < deadline) await sleep(100);
  await manager?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function fail(message) {
  console.error(`::error::${message}`);
  console.error(logs());
  if (!apps[0]?.exited) capture();
  writeFileSync(`${screenshot}.log`, logs());
  await cleanUp();
  process.exit(1);
}

async function until(what, check, { app = apps[0], seconds = STEP_SECONDS } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (app && /^failed: /m.test(app.log)) await fail(`${app.name} reported a failure while waiting for ${what}.`);
    if (app?.exited) await fail(`${app.name} exited while waiting for ${what}: ${JSON.stringify(app.exited)}.`);
    if (Date.now() > deadline) await fail(`No ${what} within ${seconds} s.`);
    await sleep(100);
  }
}

const ready = (app) => until('first frame', () => /^ready: /m.test(app.log), { app, seconds: READY_SECONDS });

/** The page's last staging decision, as mode, mark and helper poses. */
function reaction(app) {
  const [, mode, mark, helpers] = [...app.log.matchAll(/^reaction: (\w+), mark (\w+), helpers (.*)$/gm)].at(-1) ?? [];
  return `${mode} ${mark} ${helpers}`;
}

const reacts = (state) => until(`reaction "${state}"`, () => reaction(apps[0]) === state);

/** Agent Guild's events endpoint as src/manager/server.mjs serves it: Host and Origin checks, the Bearer token, protocol pings. */
async function fakeManager(token) {
  const fake = { sockets: [], refused: 0, pongs: 0 };
  const server = createServer((req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const { port } = server.address();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!hosts.includes(String(req.headers.host || '').toLowerCase())) return reject(403, 'Forbidden');
    const { origin } = req.headers;
    if (origin !== undefined && !hosts.map((host) => `http://${host}`).includes(origin)) return reject(403, 'Forbidden');
    const auth = req.headers.authorization || '';
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) {
      fake.refused += 1;
      return reject(401, 'Unauthorized');
    }
    if (new URL(req.url, 'http://localhost').pathname !== '/api/v1/events') return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('pong', () => { fake.pongs += 1; });
      ws.on('error', () => {});
      fake.sockets.push(ws);
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  fake.port = server.address().port;
  fake.close = () => new Promise((resolve) => {
    for (const ws of wss.clients) ws.terminate();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return fake;
}

const now = () => new Date().toISOString();
const session = (fields) => ({
  id: 'a1b2c3d4',
  name: 'smoke',
  provider: { id: 'claude', vendor: 'Anthropic', tool: 'Claude Code' },
  cwd: home,
  task: 'not for the page',
  status: 'running',
  exitCode: null,
  signal: null,
  activity: 'active',
  lastOutputAt: now(),
  createdAt: now(),
  startedAt: now(),
  exitedAt: null,
  agents: [],
  shells: [],
  ...fields,
});
const hello = (sessions) => ({ type: 'hello', version: 'smoke', pid: process.pid, platform: process.platform, startedAt: now(), sessions, heartbeat: true });
const send = (ws, message) => ws.send(JSON.stringify(message));

const first = start('first');
await ready(first);
await sleep(SETTLE_SECONDS * 1000);
if (first.exited) await fail(`The app exited after its first frame: ${JSON.stringify(first.exited)}.`);
if (reaction(first) !== 'rest asleep none') await fail('With no manager, the app should rest, asleep.');
capture();

const starts = () => first.log.match(/^start: /gm).length;
const startsBefore = starts();
const second = start('second');
await until('exit of a second launch', () => second.exited);
if (second.exited.code !== 0) await fail(`A second launch should exit quietly, not ${JSON.stringify(second.exited)}.`);
if (starts() !== startsBefore) await fail('A second launch restarted the first.');

const token = randomBytes(24).toString('hex');
manager = await fakeManager(token);
writeFileSync(path.join(home, 'auth-token'), `${'0'.repeat(48)}\n`);
writeFileSync(path.join(home, 'manager.json'), `${JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: manager.port, url: `http://127.0.0.1:${manager.port}`, version: 'smoke', startedAt: now() }, null, 2)}\n`);
await until('refusal of a wrong token', () => manager.refused > 0);
writeFileSync(path.join(home, 'auth-token'), `${token}\n`);
await until('connection with the token', () => manager.sockets.length === 1);

const [link] = manager.sockets;
send(link, hello([session()]));
await reacts('work null none');
link.ping();
await until('answer to the heartbeat', () => manager.pongs > 0);
send(link, { type: 'session.updated', session: session({ status: 'exited', activity: 'quiet', exitCode: 1, exitedAt: now() }) });
await reacts('done failed none');
const shown = () => first.log.match(/^(reaction: |manager: gone$)/gm).length;
const shownBefore = shown();
link.terminate();
await until('reconnection', () => manager.sockets.length === 2);
if (shown() !== shownBefore) {
  await fail('A brief loss of the manager changed what the app shows.');
}
const relink = manager.sockets[1];
send(relink, hello([session()]));
await reacts('work null none');
send(relink, { type: 'session.created', session: session({ id: 'e5f6a7b8', activity: 'quiet', lastOutputAt: '2000-01-01T00:00:00.000Z', shells: [{ id: 's1', kind: 'command' }] }) });
await reacts('work null working');
send(relink, { type: 'session.removed', sessionId: 'a1b2c3d4' });
await reacts('rest null working');
send(relink, { type: 'session.removed', sessionId: 'e5f6a7b8' });
await reacts('rest asleep none');

first.child.kill();
await until('exit of the first', () => first.exited, { app: null });
const relaunch = start('relaunch');
await ready(relaunch);

if (apps.some((app) => /^(failed|helpers): /m.test(app.log))) await fail('The app reported an error.');
writeFileSync(`${screenshot}.log`, logs());
console.log(logs());
await cleanUp();
console.log('The app started, drew its first frame, kept running, started only once, followed a manager through a reconnect and started again.');
process.exit(0);
