// Starts the built app on a clean machine and checks that it draws its first frame and keeps running.
// With no manager to find, it should simply rest. A screenshot goes beside it for a person to look at.
//   node scripts/smoke.mjs <app executable> <screenshot.png>
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [executable, screenshot] = process.argv.slice(2);
if (!executable || !screenshot) throw new Error('usage: smoke.mjs <app executable> <screenshot.png>');

const READY_SECONDS = 120; // runners draw in software, and the first load is slow
const SETTLE_SECONDS = 8; // long enough to crash, and for a clip to be under way

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const home = mkdtempSync(path.join(tmpdir(), 'companion-smoke-'));
const app = spawn(executable, [], { env: { ...process.env, AGENT_GUILD_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });

let log = '';
let exited = null;
app.stderr.on('data', (chunk) => { log += chunk; });
app.on('exit', (code, signal) => { exited = { code, signal }; });
app.on('error', (error) => { exited = { error: String(error) }; });

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

function fail(message) {
  console.error(`::error::${message}`);
  console.error(log);
  capture();
  writeFileSync(`${screenshot}.log`, log);
  app.kill();
  process.exit(1);
}

const deadline = Date.now() + READY_SECONDS * 1000;
while (!/^ready: /m.test(log)) {
  if (/^failed: /m.test(log)) fail('The app could not start.');
  if (exited) fail(`The app exited before its first frame: ${JSON.stringify(exited)}.`);
  if (Date.now() > deadline) fail(`The app drew nothing within ${READY_SECONDS} s and is still running. Its last line above shows how far it got.`);
  await sleep(250);
}
await sleep(SETTLE_SECONDS * 1000);
if (exited) fail(`The app exited after its first frame: ${JSON.stringify(exited)}.`);
if (!/^reaction: rest, mark asleep, helpers none$/m.test(log)) fail('With no manager, the app should rest, asleep.');
if (/^(failed|helpers): /m.test(log)) fail('The app reported an error.');
capture();
app.kill();
writeFileSync(`${screenshot}.log`, log);
console.log(log);
console.log('The app started, drew its first frame and kept running.');
process.exit(0);
