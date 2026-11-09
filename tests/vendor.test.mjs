import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the vendored Yard model is the one its source record names', () => {
  const source = JSON.parse(readFileSync(new URL('../web/vendor/model.source.json', import.meta.url), 'utf8'));
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.path, 'web/yard/model.mjs');
  assert.equal(createHash('sha256').update(readFileSync(new URL('../web/vendor/model.mjs', import.meta.url))).digest('hex'), source.sha256);
});
