const cleanup = 'Cleanup OK: client, Valkey, network, all run volumes and local state absent';
const missing = 'verify: After: PONG; GET=KEY_MISSING';
const matched = /^After: PONG; GET matched the exact pre-replacement value \(\d+\.\d{2}s \/ 30s\)$/;
// GNU Make reports the CLI's exit 1 and itself exits 2. Older versions omit the recipe location.
const recipeFailed = /^make: \*\*\* \[(?:Makefile:\d+: )?wrong-volume\] Error 1$/;

// Node 24.1.0 emits this warning before running the TypeScript lab CLI.
const typeStrippingWarning = /^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/;

export function evidence(goal, code, stdout, stderr) {
  stderr = stderr.replace(typeStrippingWarning, '');
  const lines = stdout.replace(/\n$/, '').split('\n');
  const after = lines.filter((line) => line.startsWith('After: PONG;'));
  const cleanups = lines.filter((line) => line.startsWith('Cleanup '));
  // The lab prints this only after checking absence of all run resources and removing state.
  if (cleanups.length !== 1 || lines.at(-1) !== cleanup) return;

  if (goal === 'verify' && code === 0 && stderr === '' && after.length === 1 && matched.test(after[0])) {
    return [after[0], cleanup];
  }
  const errors = stderr.replace(/\n$/, '').split('\n');
  if (goal === 'wrong-volume' && code === 2 && after.length === 0
    && errors.length === 2 && errors[0] === missing && recipeFailed.test(errors[1])) {
    return [missing, cleanup];
  }
}
