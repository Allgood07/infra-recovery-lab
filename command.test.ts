import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './command.ts';

const stopper = `
  const fs = require('node:fs');
  const [pidFile, stopped] = process.argv.slice(1);
  process.on('SIGTERM', () => setTimeout(() => {
    fs.writeFileSync(stopped, 'stopped');
    process.exit(0);
  }, 75));
  fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 100);
`;

for (const mode of ['timeout', 'abort']) {
  test(`${mode} waits for the child to finish before rejecting`, { timeout: 8_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'infra-command-test-'));
    const pidFile = join(dir, 'pid');
    const stopped = join(dir, 'stopped');
    const controller = new AbortController();
    try {
      const result = run([process.execPath, '-e', stopper, pidFile, stopped], {
        env: {}, signal: controller.signal, timeout: mode === 'timeout' ? 1_000 : 4_000,
      });
      const failure = rejects(result, mode === 'timeout' ? /command timed out/ : /synthetic interruption/);
      if (mode === 'abort') {
        const limit = performance.now() + 2_000;
        while (performance.now() < limit) {
          if (await stat(pidFile).catch(() => null)) break;
          await sleep(15);
        }
        controller.abort(new Error('synthetic interruption'));
      }
      await failure;
      equal(await readFile(stopped, 'utf8'), 'stopped');
      const pid = Number(await readFile(pidFile, 'utf8'));
      throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('argv is literal and unsuccessful commands reject unless explicitly unchecked', async () => {
  const literal = '$HOME; $(false)';
  deepEqual(await run([process.execPath, '-e', 'console.log(process.argv[1])', literal], { env: {} }),
    { code: 0, stdout: `${literal}\n`, stderr: '' });
  const bad: [string, ...string[]] = [process.execPath, '-e', 'console.error("synthetic failure"); process.exit(3)'];
  await rejects(run(bad, { env: {} }), /exit 3 synthetic failure/);
  equal((await run(bad, { env: {}, check: false })).code, 3);
});
