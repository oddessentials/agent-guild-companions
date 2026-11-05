// A semantic-release plugin: the plan job's dry run writes the next version and its notes here,
// and release.yml does the rest, so nothing can publish until the installers exist.
import fs from 'node:fs';
import path from 'node:path';

export async function generateNotes(pluginConfig, { env, lastRelease, nextRelease }) {
  const dir = env.RELEASE_PLAN_DIR;
  if (!dir) throw new Error('RELEASE_PLAN_DIR must name the folder that receives the release plan');
  if (!lastRelease?.version) {
    throw new Error('No release tag was found, so the next version cannot follow from one. Tag the commit before the first release, for example v0.0.0.');
  }
  const install = [
    '### Install',
    '',
    'Download **Grove-Companion-windows-setup.exe** for Windows or **Grove-Companion-macos.dmg** for macOS. It needs [Agent Guild](https://github.com/oddessentials/agent-guild) running, and nothing else.',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version'), nextRelease.version);
  fs.writeFileSync(path.join(dir, 'notes.md'), `${[nextRelease.notes, install].filter(Boolean).join('\n\n')}\n`);
  return install;
}
