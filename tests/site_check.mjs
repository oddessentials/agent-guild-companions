import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  console.error('site_check installs, uninstalls and deletes Grove Companion data, so it runs only on a GitHub-hosted Actions runner.');
  process.exit(1);
}

const windows = process.platform === 'win32';
const lang = windows ? 'powershell' : 'sh';
const page = readFileSync(new URL('../site/index.md', import.meta.url), 'utf8');
const id = 'com.oddessentials.agentguild.companion';
const data = windows
  ? [join(process.env.APPDATA, id), join(process.env.LOCALAPPDATA, id)]
  : [join(homedir(), 'Library/Application Support', id), join(homedir(), 'Library/WebKit', id)];
const app = windows ? join(process.env.LOCALAPPDATA, 'Grove Companion', 'agent-guild-companions.exe') : '/Applications/Grove Companion.app';
const agent = join(homedir(), 'Library/LaunchAgents', `${id}.plist`);
const work = mkdtempSync(join(tmpdir(), 'companion-site-'));

function block(heading) {
  const section = page.split(/^## /m).find((part) => part.split(/\r?\n/)[0] === heading);
  const code = section?.match(new RegExp('^```' + lang + '\\r?\\n([\\s\\S]*?)^```', 'm'))?.[1];
  assert.ok(code, `"${heading}" has no ${lang} block`);
  return code;
}

function run(heading) {
  const file = join(work, windows ? 'block.ps1' : 'block.sh');
  writeFileSync(file, block(heading));
  const done = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    : spawnSync('sh', [file], { encoding: 'utf8' });
  assert.equal(done.status, 0, `"${heading}" failed: ${done.error ?? done.stderr ?? ''}\n${done.stdout}`);
  if (!windows) assert.equal(done.stderr, '', `"${heading}" printed warnings`);
  const last = done.stdout.trim().split(/\r?\n/).at(-1);
  console.log(`${heading}: ${last}`);
  return last;
}

function startsAtSignIn() {
  try {
    if (windows) execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Grove Companion'], { stdio: 'ignore' });
    else assert.equal(execFileSync('plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', agent], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), `${app}/Contents/MacOS/agent-guild-companions`);
    return true;
  } catch {
    return false;
  }
}

// The choice the app's "Start at sign-in" setting makes, made here the way the app makes it.
const choices = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
function turnOff() {
  if (windows) execFileSync('reg', ['add', choices, '/v', 'Grove Companion', '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f'], { stdio: 'ignore' });
  else execFileSync('launchctl', ['disable', `gui/${process.getuid()}/${id}`]);
}

function turnedOff() {
  if (!windows) return new RegExp(`"${id}" => (disabled|true)`).test(execFileSync('launchctl', ['print-disabled', `gui/${process.getuid()}`], { encoding: 'utf8' }));
  const found = spawnSync('reg', ['query', choices, '/v', 'Grove Companion'], { encoding: 'utf8' });
  return found.status === 0 && /REG_BINARY\s+03/.test(found.stdout);
}

try {
  assert.equal(run('Install'), 'Installed.');
  assert.equal(run('Check'), 'Grove Companion is running.');
  assert.ok(existsSync(app), `${app} is installed`);
  assert.equal(startsAtSignIn(), true);

  for (const dir of data) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'site-check'), '');
  }
  assert.equal(turnedOff(), false);
  turnOff();

  assert.equal(run('Install'), 'Installed.');
  assert.equal(run('Check'), 'Grove Companion is running.');
  assert.equal(startsAtSignIn(), true);
  assert.equal(turnedOff(), true, 'updating kept the choice not to start at sign-in');
  for (const dir of data) assert.ok(existsSync(join(dir, 'site-check')), `updating kept ${dir}`);

  assert.equal(run('Uninstall'), 'Uninstalled.');
  assert.equal(run('Check'), 'Grove Companion is not running.');
  assert.ok(!existsSync(app), `${app} is removed`);
  assert.equal(startsAtSignIn(), false);
  assert.equal(turnedOff(), windows, windows ? 'uninstalling kept the choice' : 'uninstalling cleared the choice');
  for (const dir of data) assert.ok(existsSync(join(dir, 'site-check')), `uninstalling kept ${dir}`);

  assert.equal(run('Remove its saved data'), 'Removed.');
  for (const dir of data) assert.ok(!existsSync(dir), `${dir} is removed`);
  assert.equal(turnedOff(), false, 'removing saved data cleared the choice');
  console.log('ok   the page installs, checks, updates and uninstalls Grove Companion');
} finally {
  rmSync(work, { recursive: true, force: true });
}
