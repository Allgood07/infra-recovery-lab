import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandResult, Execute } from './command.ts';
import { cliReply, Lab, localDocker, ready, requireRecoveredValue, validateReplacementPlan } from './verify.ts';

const HOST = 'unix:///tmp/selected-docker.sock';
const ADDRESS = '172.19.0.3';
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const pong = ok('"PONG"\n');
const loading = { code: 1, stdout: '', stderr: 'LOADING Valkey is loading the dataset in memory\n' };

const server = ['docker_container.valkey', ['create']] as const;
const empty = ['docker_volume.empty[0]', ['create']] as const;
const original = ['docker_volume.data', ['no-op']] as const;
const resource = ([address, actions]: readonly [string, readonly string[]]) => ({ address, change: { actions } });
const plan = (...changes: Parameters<typeof resource>[0][]) => ({ errored: false, resource_changes: changes.map(resource) });

test('replacement permits exactly the creates for each mode', () => {
  deepEqual(validateReplacementPlan(plan(original, server), false), ['docker_container.valkey']);
  deepEqual(validateReplacementPlan(plan(empty, original, server), true), ['docker_container.valkey', 'docker_volume.empty[0]']);
});

test('unexpected plan actions are refused in both modes', async (t) => {
  const moved = { ...resource(original), previous_address: 'docker_volume.old' };
  const imported = { ...resource(original), change: { actions: ['no-op'], importing: { id: 'synthetic-volume' } } };
  const cases: [string, boolean, unknown][] = [
    ['extra create in normal mode', false, plan(server, empty)],
    ['delete then create', false, plan([server[0], ['delete', 'create']])],
    ['errored', false, { ...plan(server), errored: true }],
    ['deferred', false, { ...plan(server), deferred_changes: [{ reason: 'deferred_prereq' }] }],
    ['changed output', false, { ...plan(server), output_changes: { new_output: { actions: ['create'] } } }],
    ['moved data', false, { ...plan(server), resource_changes: [resource(server), moved] }],
    ['imported data', false, { ...plan(server), resource_changes: [resource(server), imported] }],
    ['missing empty volume', true, plan(server)],
    ['missing replacement', true, plan(empty)],
    ['duplicate empty volume', true, plan(server, empty, empty)],
    ['deleted original volume', true, plan(server, empty, [original[0], ['delete']])],
    ['updated network', true, plan(server, empty, ['docker_network.run', ['update']])],
    ['malformed actions', false, { ...plan(server), resource_changes: [{ address: server[0], change: { actions: 'create' } }] }],
  ];
  for (const [name, wrongVolume, details] of cases) {
    await t.test(name, () => throws(() => validateReplacementPlan(details, wrongVolume), /^Error: Refusing replacement plan/));
  }
});

test('a null GET is missing; a different or empty string is a mismatch', async (t) => {
  const expected = 'synthetic:expected';
  for (const [raw, diagnosis] of [
    ['["PONG",null]', 'KEY_MISSING'],
    ['["PONG","synthetic:other"]', 'VALUE_MISMATCH'],
    ['["PONG",""]', 'VALUE_MISMATCH'],
  ]) {
    await t.test(raw, () => throws(() => requireRecoveredValue(cliReply(ok(raw)), expected),
      { message: `After: PONG; GET=${diagnosis}` }));
  }
  requireRecoveredValue(['PONG', expected], expected);
  for (const invalid of [['unexpected', null], ['PONG'], ['PONG', 0], null]) {
    throws(() => requireRecoveredValue(invalid, expected), { message: 'Expected PONG and GET reply' });
  }
});

test('absence check detects a remaining empty volume even without its label', async () => {
  const lab: Lab = new Lab(HOST, true, {}, async (args): Promise<CommandResult> => {
    const volumeList = args[3] === 'volume' && args[4] === 'ls' && !args.includes('--filter');
    return ok(volumeList ? `${lab.emptyVolume}\n` : '');
  });
  await rejects(lab.assertAbsent(), /volume still exists/);
});

test('CLI and provider use only the selected socket', async (t) => {
  const env = { DOCKER_CONTEXT: 'local', DOCKER_HOST: 'tcp://ignored:2375', TF_VAR_docker_host: 'tcp://ignored:1234' };
  const execute = t.mock.fn<Execute>(async (argv) => {
    if (argv[1] === 'context') return ok(`${HOST}\n`);
    if (argv[0] === 'tofu') throw new Error('stop at apply');
    return ok();
  });
  const isSocket = t.mock.fn((_path: string) => true);
  const lab = new Lab(await localDocker(env, execute, isSocket), false, env, execute);
  t.mock.method(lab, 'init', async () => {});
  await lab.docker(['info']);
  await rejects(lab.scenario(), /stop at apply/);

  deepEqual(isSocket.mock.calls.map(({ arguments: args }) => args), [['/tmp/selected-docker.sock']]);
  const [select, cli, apply] = execute.mock.calls.map(({ arguments: args }) => args);
  deepEqual(select[0], ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', '--', 'local']);
  deepEqual(cli[0], ['docker', '--host', HOST, 'info']);
  equal(apply[0][2], 'apply');
  equal(apply[0].includes(`-var=docker_host=${HOST}`), true);
  for (const [, options] of [select, cli, apply]) {
    equal(Object.hasOwn(options?.env ?? {}, 'DOCKER_CONTEXT'), false);
    equal(Object.hasOwn(options?.env ?? {}, 'DOCKER_HOST'), false);
  }
  equal(Object.hasOwn(apply[1]?.env ?? {}, 'TF_VAR_docker_host'), false);

  equal(await localDocker({ DOCKER_HOST: HOST }, execute, isSocket), HOST);
  equal(execute.mock.callCount(), 3); // Explicit host did not consult the current context.
  await rejects(localDocker({ DOCKER_HOST: 'tcp://ignored:2375' }, execute, isSocket), /local Docker Unix socket/);
  await rejects(localDocker({ DOCKER_HOST: HOST }, execute, () => false), /local Docker Unix socket/);
});

function clock(...times: number[]) {
  return () => {
    const now = times.shift();
    if (now === undefined) throw new Error('unexpected extra time sample');
    return now;
  };
}

test('LOADING retries with the remaining budget', async () => {
  const budgets: number[] = [];
  const delays: number[] = [];
  equal(await ready(ADDRESS, 5_000, async (ms) => {
    budgets.push(ms);
    return budgets.length === 1 ? loading : pong;
  }, clock(0, 1_000, 2_000, 3_000), async (ms) => { delays.push(ms); }), 'PONG');
  deepEqual(budgets, [5_000, 3_000]);
  deepEqual(delays, [100]);
});

test('LOADING cannot extend the deadline', async (t) => {
  const cli = t.mock.fn(async (_remaining: number) => loading);
  const pause = t.mock.fn(async () => {});
  await rejects(ready(ADDRESS, 5_000, cli, clock(0, 5_000, 5_000), pause), /deadline exceeded/);
  deepEqual(cli.mock.calls.map(({ arguments: args }) => args), [[5_000]]);
  equal(pause.mock.callCount(), 0);
  await rejects(ready(ADDRESS, 5_000, async () => ok('["PONG",null]'), clock(0, 5_001)), /deadline exceeded/);
});

test('other server errors or malformed replies are not retried', async (t) => {
  for (const [name, result, expected] of [
    ['denied', { code: 1, stdout: '', stderr: 'NOPERM denied\n' }, /NOPERM denied/],
    ['LOADING on stdout', { code: 1, stdout: 'LOADING unavailable\n', stderr: '' }, /valkey-cli failed/],
    ['nonzero exit even with null', { code: 1, stdout: '["PONG",null]', stderr: '' }, /valkey-cli failed/],
    ['stderr even with exit zero', { code: 0, stdout: '["PONG",null]', stderr: 'unexpected' }, /valkey-cli failed/],
    ['not JSON', ok('not JSON\n'), /invalid JSON/],
  ] as const) {
    await t.test(name, async (st) => {
      const cli = st.mock.fn(async (_remaining: number) => result);
      await rejects(ready(ADDRESS, 5_000, cli, () => 0), (error: Error) => {
        equal(error.message.includes('KEY_MISSING'), false);
        return expected.test(error.message);
      });
      deepEqual(cli.mock.calls.map(({ arguments: args }) => args), [[5_000]]);
    });
  }
});

test('a recognized connection error also retries with only the remaining budget', async (t) => {
  const refused = { code: 1, stdout: '', stderr: `Could not connect to Valkey at ${ADDRESS}:6379: Connection refused\n` };
  const responses = [refused, pong];
  const cli = t.mock.fn(async (_remaining: number) => responses.shift()!);
  equal(await ready(ADDRESS, 5_000, cli, clock(0, 1_000, 2_000, 3_000), async () => {}), 'PONG');
  deepEqual(cli.mock.calls.map(({ arguments: args }) => args), [[5_000], [3_000]]);
});
