import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number; // milliseconds
  check?: boolean;
}

export type Execute = (argv: [string, ...string[]], options?: CommandOptions) => Promise<CommandResult>;

export const run: Execute = async ([program, ...args], options = {}) => {
  const { env, signal, timeout = 15_000, check = true } = options;
  signal?.throwIfAborted();
  const label = [program, ...args.slice(0, 3)].join(' ');
  return new Promise((resolve, reject) => {
    // An isolated Unix process group also covers subprocesses such as provider plugins.
    const child = spawn(program, args, { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    let failure: Error | undefined;
    let force: NodeJS.Timeout | undefined;

    const killGroup = (signum: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signum);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          failure = new Error(`${label}: could not send ${signum}: ${String(error)}`, { cause: failure });
        }
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), 1_000);
    };
    const abort = () => stop(new Error(`${label}: ${String(signal?.reason)}`));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${label}: command timed out`)), timeout);
    child.once('error', (error) => { failure ??= error; });
    // Do not let timeout/abort advance to cleanup while the child is still running.
    child.once('close', (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (force) {
        clearTimeout(force);
        killGroup('SIGKILL'); // Also stop remaining group members if the leader exited first.
      }
      if (failure) reject(failure);
      else if (childSignal) reject(new Error(`${label}: killed by ${childSignal}`));
      else if (check && code !== 0) {
        reject(new Error(`${label}: exit ${code} ${(stderr || stdout).trim()}`.trimEnd()));
      } else resolve({ code, stdout, stderr });
    });
  });
};
