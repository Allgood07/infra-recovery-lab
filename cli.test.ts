import { equal, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
const options = { env: { PATH: '/dev/null' }, encoding: 'utf8', timeout: 5_000 } as const;

test('CLI rejects an unknown argument without Docker', () => {
  const result = spawnSync(process.execPath, [cli, '--unknown'], options);
  equal(result.error, undefined);
  equal(result.signal, null);
  equal(result.status, 2);
  equal(result.stdout, '');
  match(result.stderr, /^Usage: node cli\.ts \[--wrong-volume\]$/m);
});
