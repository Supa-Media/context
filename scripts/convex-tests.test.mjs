import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChanged, selectTests, RUN_EVERYTHING, balanceShard, balanceShards, parseShard, withoutShard } from './convex-tests.mjs';
import { median, medianTimings, parseTimings } from './convex-test-timings.mjs';

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

// Shard balancing. Synthetic files and timings, so the properties hold for any
// suite: the committed timings only change the balance, never the partition.

const CONVEX_DIR = 'apps/convex/__tests__/';
const sorted = (list) => [...list].sort();
/** 40 files with a fixed, uneven spread of weights. */
const many = Array.from({ length: 40 }, (_, i) => `${CONVEX_DIR}gen/file${String(i).padStart(2, '0')}.test.ts`);
const weights = Object.fromEntries(many.map((file, i) => [file.slice('apps/convex/'.length), ((i * 7919) % 97) * 100 + 50]));
const reversed = [...many].reverse();

test('every shard count partitions the files: each on exactly one shard, none lost or added', () => {
  for (const files of [many, many.slice(0, 5), many.slice(0, 1), []]) {
    for (let count = 1; count <= 6; count++) {
      const all = Array.from({ length: count }, (_, i) => balanceShard(files, weights, i + 1, count)).flat();
      assert.deepEqual(sorted(all), sorted(files), `${files.length} files over ${count} shards`);
    }
  }
  // More shards than files: the extra shards are empty, the rest hold one file each.
  const eight = Array.from({ length: 8 }, (_, i) => balanceShard(many.slice(0, 3), weights, i + 1, 8));
  assert.deepEqual(eight.map((files) => files.length), [1, 1, 1, 0, 0, 0, 0, 0]);
});

test('the split does not depend on the order the files are listed in', () => {
  for (let count = 1; count <= 6; count++) {
    for (let index = 1; index <= count; index++) {
      assert.deepEqual(balanceShard(reversed, weights, index, count), balanceShard(many, weights, index, count));
    }
  }
  // Equal weights: ties go by path, then to the lowest shard index.
  const timings = { '__tests__/x.test.ts': 5, '__tests__/y.test.ts': 5, '__tests__/z.test.ts': 5 };
  const files = ['apps/convex/__tests__/z.test.ts', 'apps/convex/__tests__/y.test.ts', 'apps/convex/__tests__/x.test.ts'];
  assert.deepEqual(balanceShard(files, timings, 1, 2), ['apps/convex/__tests__/x.test.ts', 'apps/convex/__tests__/z.test.ts']);
  assert.deepEqual(balanceShard(files, timings, 2, 2), ['apps/convex/__tests__/y.test.ts']);
});

test('the heaviest files land on different shards', () => {
  const weightsOfHeavy = [6000, 5000, 4000, 3000, 2000, 1000];
  const heavy = weightsOfHeavy.map((_, i) => `${CONVEX_DIR}heavy${i}.test.ts`);
  const light = Array.from({ length: 30 }, (_, i) => `${CONVEX_DIR}light${i}.test.ts`);
  const timings = {
    ...Object.fromEntries(heavy.map((file, i) => [file.slice('apps/convex/'.length), weightsOfHeavy[i]])),
    ...Object.fromEntries(light.map((file) => [file.slice('apps/convex/'.length), 10])),
  };
  const shards = balanceShards([...light, ...heavy], timings, 6);
  const holders = heavy.map((file) => shards.findIndex((shard) => shard.files.includes(file)));
  assert.equal(new Set(holders).size, 6, `heavy files on shards ${holders}`);
});

test('a file with no recorded time weighs the median of the recorded times, or 1000 ms when there are none', () => {
  const timings = { '__tests__/a.test.ts': 100, '__tests__/b.test.ts': 300, '__tests__/c.test.ts': 500 };
  assert.equal(median(Object.values(timings)), 300);
  const unknown = `${CONVEX_DIR}unknown.test.ts`;
  // One shard holds everything, so its estimate is the sum of the weights.
  const everything = [...Object.keys(timings).map((key) => `apps/convex/${key}`), unknown];
  assert.equal(balanceShards(everything, timings, 1)[0].ms, 100 + 300 + 500 + 300);
  assert.equal(balanceShards([unknown], {}, 1)[0].ms, 1000);
  assert.equal(median([]), null);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('balanceShard rejects a shard index outside 1..count', () => {
  assert.throws(() => balanceShard(many, weights, 0, 6), /not in 1\.\.6/);
  assert.throws(() => balanceShard(many, weights, 7, 6), /not in 1\.\.6/);
  assert.throws(() => balanceShards(many, weights, 0), /positive integer/);
});

test('--shard=i/n is removed from the arguments, and the rest are kept', () => {
  assert.deepEqual(parseShard(['--shard=2/6', '--reporter=dot']), { index: 2, count: 6 });
  assert.deepEqual(withoutShard(['--shard=2/6', '--reporter=dot']), ['--reporter=dot']);
  assert.equal(parseShard(['--reporter=dot']), null);
  assert.deepEqual(withoutShard(['--reporter=dot']), ['--reporter=dot']);
  for (const bad of [['--shard=2'], ['--shard', '2/6'], ['--shard=7/6'], ['--shard=0/6'], ['--shard=1/6', '--shard=2/6']]) {
    assert.throws(() => parseShard(bad), /shard/, JSON.stringify(bad));
  }
});

test('the dry run lists each shard once: the six shards together are the whole suite', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.test.ts') ? [relative(root, path)] : [];
  });
  const suite = walk(join(root, 'apps/convex/__tests__'));
  const listed = [];
  for (let index = 1; index <= 6; index++) {
    const result = spawnSync(process.execPath, ['scripts/convex-tests.mjs', `--shard=${index}/6`, '--reporter=dot'], {
      cwd: root,
      env: { ...process.env, CONVEX_TESTS_DRY_RUN: '1', CONVEX_TEST_CHANGED: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Shard ${index}/6: \\d+ of ${suite.length} Convex test files`));
    listed.push(...result.stdout.split('\n').filter((line) => line.startsWith('  apps/convex/')).map((line) => line.trim()));
  }
  assert.deepEqual(sorted(listed), sorted(suite));
});

test('the committed timings are sorted, with whole-millisecond values', () => {
  const timings = JSON.parse(readFileSync(new URL('../apps/convex/.test-timings.json', import.meta.url), 'utf8'));
  const keys = Object.keys(timings);
  assert.deepEqual(keys, sorted(keys));
  for (const key of keys) assert.ok(Number.isInteger(timings[key]) && timings[key] >= 0, key);
});

// The refresh script's parser, on lines as vitest prints them in a job log.

test('the log parser reads vitest result lines, with colour, timestamps, other markers and missing durations', () => {
  const log = [
    '2026-11-18T10:00:00.1234567Z \u001b[32m ✓\u001b[39m __tests__/grants.test.ts \u001b[2m(31 tests)\u001b[22m \u001b[32m940ms\u001b[39m',
    ' ✓ __tests__/accessAdds.test.ts (12 tests | 1 skipped) 2.5s',
    ' × __tests__/failing.test.ts (3 tests | 1 failed) 410ms',
    ' ❯ __tests__/slow.test.ts (4 tests) 83000ms',
    ' ✓ __tests__/untimed.test.ts (1 test)',
    'FAIL __tests__/failing.test.ts > suite > case',
    ' Test Files  5 passed (5)',
  ].join('\n');
  assert.deepEqual(parseTimings(log), [
    { file: '__tests__/grants.test.ts', ms: 940 },
    { file: '__tests__/accessAdds.test.ts', ms: 2500 },
    { file: '__tests__/failing.test.ts', ms: 410 },
    { file: '__tests__/slow.test.ts', ms: 83000 },
    { file: '__tests__/untimed.test.ts', ms: 0 },
  ]);
});

test('the refresh takes the median of each file across the logs, sorted by key', () => {
  const log = (ms) => `2026-11-18T10:00:00Z  ✓ __tests__/b.test.ts (2 tests) ${ms}ms\n ✓ __tests__/a.test.ts (1 test) 50ms\n`;
  assert.deepEqual(medianTimings([log(100), log(300), log(200)]), { '__tests__/a.test.ts': 50, '__tests__/b.test.ts': 200 });
  assert.deepEqual(medianTimings([log(100), log(300)]), { '__tests__/a.test.ts': 50, '__tests__/b.test.ts': 200 });
  assert.deepEqual(medianTimings(['no results here\n']), {});
});
