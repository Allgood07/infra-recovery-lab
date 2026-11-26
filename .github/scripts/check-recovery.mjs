import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidence } from './recovery-evidence.mjs';

function check(goal) {
  if (goal !== 'verify' && goal !== 'wrong-volume') throw new Error('Expected verify or wrong-volume');
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), `recovery-${goal}-`));
  const paths = ['stdout', 'stderr'].map((name) => join(dir, name));
  const fds = [];
  try {
    for (const path of paths) fds.push(openSync(path, 'wx'));
    const { status, signal, error } = spawnSync('make', [goal], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', ...fds],
    });
    writeFileSync(join(dir, 'exit-code'), `${status ?? 'unavailable'}\n`);
    console.log(`make ${goal}: exit ${status ?? 'unavailable'}`);
    if (signal || error) throw new Error(`make ${goal} did not complete normally`);
    const lines = evidence(goal, status, ...paths.map((path) => readFileSync(path, 'utf8')));
    if (!lines) throw new Error(`make ${goal}: expected exit, client result and cleanup not confirmed`);
    // Only approved evidence reaches the job log, not the full transcript.
    console.log(lines.join('\n'));
  } finally {
    for (const fd of fds) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

check(process.argv[2]);
