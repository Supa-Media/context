import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChanged, selectTests, RUN_EVERYTHING } from './convex-tests.mjs';

const T = 'apps/convex/__tests__/';
const F = 'apps/convex/functions/';
const tests = [`${T}calendar.test.ts`, `${T}chat.test.ts`, `${T}structure/glob.test.ts`, `${T}brandNew.test.ts`];
const map = [
  { test: `${T}calendar.test.ts`, deps: [`${T}calendar.test.ts`, `${F}calendarWrite.ts`, `${F}lib/google.ts`] },
  { test: `${T}chat.test.ts`, deps: [`${T}chat.test.ts`, `${F}chat.ts`, `${F}lib/google.ts`, 'apps/mcp/src/controlPlane/chat.js'] },
  // Reads every function file, the way a `?raw` glob over the folder does.
  { test: `${T}structure/glob.test.ts`, deps: [`${F}calendarWrite.ts`, `${F}chat.ts`, `${F}other.ts`] },
];
const filesIn = (dir) => (dir === 'apps/convex/functions' ? [`${F}calendarWrite.ts`, `${F}chat.ts`, `${F}other.ts`, `${F}new.ts`] : []);
const pick = (lines) => selectTests({ tests, map, changes: parseChanged(lines.join('\n')), filesIn });

test('an edit runs the tests that used the file, plus tests the map has not seen', () => {
  assert.deepEqual(pick(['M\tapps/convex/functions/calendarWrite.ts']).files, [`${T}brandNew.test.ts`, `${T}calendar.test.ts`, `${T}structure/glob.test.ts`]);
  assert.deepEqual(pick(['M\tapps/mcp/src/controlPlane/chat.js']).files, [`${T}brandNew.test.ts`, `${T}chat.test.ts`]);
  assert.deepEqual(pick(['M\tapps/convex/functions/lib/google.ts']).files, [`${T}brandNew.test.ts`, `${T}calendar.test.ts`, `${T}chat.test.ts`]);
});

test('a changed test file always runs, and a file no test used runs none of the mapped ones', () => {
  assert.deepEqual(pick([`M\t${T}chat.test.ts`]).files, [`${T}brandNew.test.ts`, `${T}chat.test.ts`]);
  assert.deepEqual(pick(['M\tdocs/decisions/testing.md']).files, [`${T}brandNew.test.ts`]);
  assert.deepEqual(pick([`M\t${T}__snapshots__/chat.test.ts.snap`]).files, [`${T}brandNew.test.ts`, `${T}chat.test.ts`]);
});

test('adding or deleting a file runs the tests that read most of its directory', () => {
  assert.deepEqual(pick(['A\tapps/convex/functions/new.ts']).files, [`${T}brandNew.test.ts`, `${T}structure/glob.test.ts`]);
  // A rename is a delete and an add; the old path's users run too.
  assert.deepEqual(pick(['D\tapps/convex/functions/chat.ts', 'A\tapps/convex/functions/chats.ts']).files, [`${T}brandNew.test.ts`, `${T}chat.test.ts`, `${T}structure/glob.test.ts`]);
});

test('schema, setup, install and selector changes run everything, as does a missing map', () => {
  for (const path of ['apps/convex/schema.ts', 'apps/convex/functions/lib/schema/jobs.ts', 'apps/convex/test.setup.ts', 'apps/convex/vitest.config.ts', 'pnpm-lock.yaml', 'scripts/convex-tests.mjs', 'apps/convex/testImpact.setup.ts']) {
    const result = pick([`M\t${path}`]);
    assert.equal(result.files, null, path);
    assert.match(result.reason, /can change any test/);
  }
  assert.equal(selectTests({ tests, map: [], changes: [], filesIn }).files, null);
  assert.ok(RUN_EVERYTHING.every((pattern) => typeof pattern === 'string'));
});

test('an unreadable changed-file line is an error, not an empty selection', () => {
  assert.throws(() => parseChanged('apps/convex/functions/chat.ts'), /unreadable/);
});

test('the Convex package runs its tests through the selector, and CI hands it the map', () => {
  const pkg = JSON.parse(readFileSync(new URL('../apps/convex/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node ../../scripts/convex-tests.mjs');
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /convex-test-map: "apps\/convex\/\.test-map"/);
  const config = readFileSync(new URL('../apps/convex/vitest.config.ts', import.meta.url), 'utf8');
  assert.match(config, /setupFiles: process\.env\.CONVEX_TEST_MAP_RECORD \? \["\.\/testImpact\.setup\.ts"\] : \[\]/);
});
