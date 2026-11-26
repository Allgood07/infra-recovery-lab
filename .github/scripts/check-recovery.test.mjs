import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evidence } from './recovery-evidence.mjs';

const cleanup = 'Cleanup OK: client, Valkey, network, all run volumes and local state absent';
const missing = 'verify: After: PONG; GET=KEY_MISSING';
const matched = 'After: PONG; GET matched the exact pre-replacement value (0.25s / 30s)';
const makeError = 'make: *** [Makefile:6: wrong-volume] Error 1\n';
const control = `${missing}\n${makeError}`;

const wrong = (code, stdout = `${cleanup}\n`, stderr = control) => evidence('wrong-volume', code, stdout, stderr);

for (const goal of ['verify', 'wrong-volume']) {
  test(`CLI ${goal} exits with an error when make is missing`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-no-make-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cli = fileURLToPath(new URL('./check-recovery.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, goal], {
      cwd: dir,
      env: { PATH: dir, RUNNER_TEMP: dir },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, `make ${goal}: exit unavailable\n`);
    assert.ok(result.stderr.includes(`Error: make ${goal} did not complete normally`), result.stderr);
    assert.deepEqual(readdirSync(dir), []);
  });
}

test('accepts KEY_MISSING with a failed recipe and confirmed cleanup', () => {
  assert.deepEqual(wrong(2), [missing, cleanup]);
  assert.deepEqual(wrong(2, `${cleanup}\n`, `${missing}\nmake: *** [wrong-volume] Error 1\n`), [missing, cleanup]);
});

test('rejects mismatch, timeout and Docker/OpenTofu errors', () => {
  for (const diagnostic of [
    'verify: After: PONG; GET=VALUE_MISMATCH',
    'verify: Valkey readiness/read deadline exceeded',
    'verify: docker context inspect: exit 1',
    'verify: tofu plan: exit 1',
    `${missing}\nverify: tofu plan: exit 1`,
  ]) {
    assert.equal(wrong(2, `${cleanup}\n`, `${diagnostic}\n${makeError}`), undefined);
  }
  assert.equal(wrong(124), undefined);
});

test('accepts the exact Node Type Stripping warning but not additional diagnostics', () => {
  const warning = '(node:42) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n'
    + '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  assert.deepEqual(evidence('verify', 0, `${matched}\n${cleanup}\n`, warning), [matched, cleanup]);
  assert.deepEqual(wrong(2, `${cleanup}\n`, warning + control), [missing, cleanup]);
  assert.equal(wrong(2, `${cleanup}\n`, `${warning}verify: tofu plan: exit 1\n${control}`), undefined);
});

test('rejects KEY_MISSING without confirmation of all-volume cleanup', () => {
  assert.equal(wrong(2, ''), undefined);
  assert.equal(wrong(2, 'Cleanup OK: client removed\n'), undefined);
});

test('rejects an unexpectedly successful control', () => {
  assert.equal(wrong(0, `${matched}\n${cleanup}\n`, ''), undefined);
  assert.equal(wrong(0), undefined);
});

test('normal recovery needs the exact-value result and cleanup, not just exit 0', () => {
  assert.deepEqual(evidence('verify', 0, `${matched}\n${cleanup}\n`, ''), [matched, cleanup]);
  assert.equal(evidence('verify', 0, '', ''), undefined);
  assert.equal(evidence('verify', 0, `${cleanup}\n`, ''), undefined);
  assert.equal(evidence('verify', 0, `${matched}\n`, ''), undefined);
  assert.equal(evidence('verify', 2, `${matched}\n${cleanup}\n`, ''), undefined);
});
