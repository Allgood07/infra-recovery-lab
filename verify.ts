import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { run } from './command.ts';
import type { CommandOptions, CommandResult, Execute } from './command.ts';

const ROOT = import.meta.dirname;
const RUN_LABEL = 'infra-recovery-lab.run';
const WINDOW = 30_000;

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dockerEnv({ DOCKER_CONTEXT: _context, DOCKER_HOST: _host, ...env }: NodeJS.ProcessEnv) {
  return env;
}

export async function localDocker(
  env: NodeJS.ProcessEnv,
  execute = run,
  isSocket = (path: string) => statSync(path, { throwIfNoEntry: false })?.isSocket() === true,
  signal?: AbortSignal,
): Promise<string> {
  const { DOCKER_CONTEXT: context, DOCKER_HOST: explicitHost } = env;
  const host = context || !explicitHost
    ? (await execute(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}',
      ...(context ? ['--', context] : [])], { env: dockerEnv(env), signal })).stdout.trim()
    : explicitHost;
  requireThat(host.startsWith('unix:///') && isSocket(host.slice('unix://'.length)),
    'A local Docker Unix socket is required');
  return host;
}

function action(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

export function validateReplacementPlan(details: unknown, wrongVolume: boolean): string[] {
  const expected = ['docker_container.valkey'];
  if (wrongVolume) expected.push('docker_volume.empty[0]');
  const message = 'Refusing replacement plan';
  requireThat(record(details) && details.errored === false && Array.isArray(details.resource_changes)
    && (details.deferred_changes == null || (Array.isArray(details.deferred_changes) && !details.deferred_changes.length)),
  `${message}: invalid, errored or deferred plan`);
  const outputs = details.output_changes ?? {};
  requireThat(record(outputs) && Object.values(outputs).every((change) => record(change) && action(change.actions, 'no-op')),
    `${message}: unexpected output changes`);

  const seen = new Set<string>();
  const creates: string[] = [];
  for (const resource of details.resource_changes as unknown[]) {
    requireThat(record(resource) && typeof resource.address === 'string' && record(resource.change)
      && !seen.has(resource.address) && resource.previous_address == null && resource.change.importing == null,
    `${message}: invalid, duplicate, moved or imported resource`);
    seen.add(resource.address);
    if (action(resource.change.actions, 'no-op')) continue;
    requireThat(action(resource.change.actions, 'create'), `${message}: unexpected action on ${resource.address}`);
    creates.push(resource.address);
  }
  requireThat(isDeepStrictEqual(creates.sort(), expected), `${message}: creates [${creates.join(', ')}]`);
  return expected;
}

export function requireRecoveredValue(reply: unknown, expected: string): void {
  requireThat(Array.isArray(reply) && reply.length === 2 && reply[0] === 'PONG'
    && (reply[1] === null || typeof reply[1] === 'string'), 'Expected PONG and GET reply');
  requireThat(reply[1] !== null, 'After: PONG; GET=KEY_MISSING');
  requireThat(reply[1] === expected, 'After: PONG; GET=VALUE_MISMATCH');
}

function connectError(result: CommandResult, address: string): boolean {
  const prefix = `Could not connect to Valkey at ${address}:6379: `;
  return result.code === 1 && !result.stdout && [
    'Connection refused', 'Connection timed out', 'Operation timed out', 'No route to host', 'Network is unreachable',
  ].some((message) => result.stderr.trim() === prefix + message);
}

export function cliReply(result: CommandResult): unknown {
  requireThat(result.code === 0 && !result.stderr,
    `valkey-cli failed: exit ${result.code}, ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('valkey-cli returned invalid JSON');
  }
}

export async function ready(
  address: string,
  deadline: number,
  cli: (remaining: number) => Promise<CommandResult>,
  now = () => performance.now(),
  pause: (ms: number) => Promise<void> = sleep,
): Promise<unknown> {
  const expired = 'Valkey readiness/read deadline exceeded';
  for (let remaining: number; (remaining = deadline - now()) > 0;) {
    const result = await cli(remaining);
    // With -e, valkey-cli prints server errors to stderr even under --json.
    const loading = result.code === 1 && !result.stdout && result.stderr.startsWith('LOADING ');
    if (connectError(result, address) || loading) {
      const delay = Math.min(100, deadline - now());
      if (delay > 0) await pause(delay);
      continue;
    }
    const reply = cliReply(result);
    requireThat(now() <= deadline, expired);
    return reply;
  }
  throw new Error(expired);
}

interface Inspections {
  container: {
    Id: string;
    Config: { Labels: Record<string, string> | null };
    State: { Running: boolean; StartedAt: string };
    NetworkSettings: { Networks: Record<string, { IPAddress: string }>; Ports: Record<string, unknown> | null };
    Mounts: { Destination: string; Type: string; RW: boolean; Name: string }[];
  };
  network: { Id: string; Internal: boolean };
  volume: { Labels: Record<string, string> | null };
}

type Kind = keyof Inspections;
const kinds: Kind[] = ['container', 'network', 'volume'];
type Flags = Pick<CommandOptions, 'check' | 'timeout'>;

export class Lab {
  readonly name = `infra-recovery-${randomUUID().replaceAll('-', '')}`;
  readonly emptyVolume = `${this.name}-empty`;
  readonly state = join(ROOT, '.runs', this.name);
  private client: string | undefined;
  private cleaningUp = false;
  private readonly dockerEnv: NodeJS.ProcessEnv;
  private readonly tofuEnv: NodeJS.ProcessEnv;
  private readonly host: string;
  private readonly wrongVolume: boolean;
  private readonly execute: Execute;
  private readonly signal?: AbortSignal;

  constructor(host: string, wrongVolume: boolean, env: NodeJS.ProcessEnv, execute = run, signal?: AbortSignal) {
    this.host = host;
    this.wrongVolume = wrongVolume;
    this.execute = execute;
    this.signal = signal;
    // Both CLI and provider use the same explicit endpoint throughout the run.
    this.dockerEnv = dockerEnv(env);
    this.tofuEnv = {
      ...Object.fromEntries(Object.entries(this.dockerEnv).filter(([key]) => !/^(TF_|TOFU_)/.test(key))),
      TF_IN_AUTOMATION: '1',
      TF_CLI_CONFIG_FILE: join(this.state, 'cli.tfrc'),
    };
  }

  docker(args: string[], flags: Flags = {}) {
    return this.execute(['docker', '--host', this.host, ...args], {
      ...flags, env: this.dockerEnv, signal: this.cleaningUp ? undefined : this.signal,
    });
  }

  private tofu(args: string[], timeout: number) {
    return this.execute(['tofu', `-chdir=${this.state}`, ...args], { env: this.tofuEnv, timeout, signal: this.signal });
  }

  async init() {
    for (const file of ['main.tf', '.terraform.lock.hcl']) await copyFile(join(ROOT, file), join(this.state, file));
    await writeFile(join(this.state, 'cli.tfrc'), '');
    const lockHash = createHash('sha256').update(await readFile(join(this.state, '.terraform.lock.hcl'))).digest('hex');
    const mirror = join(ROOT, '.runs', `providers-${process.platform}-${process.arch}-${lockHash}`);
    const flags = ['init', '-input=false', '-no-color', '-lockfile=readonly'];
    const isMirrorDir = async () => {
      try {
        return (await stat(mirror)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    if (await isMirrorDir()) {
      await this.tofu([...flags, `-plugin-dir=${mirror}`], 180_000);
    } else {
      await this.tofu(flags, 180_000);
      // Publish only a complete mirror; parallel first runs may both bootstrap it.
      const staging = join(this.state, 'mirror');
      await cp(join(this.state, '.terraform/providers'), staging, { recursive: true, dereference: true });
      try {
        await rename(staging, mirror);
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || !await isMirrorDir()) throw error;
      }
    }
  }

  private async resources(kind: Kind, owned = false): Promise<string[]> {
    const args: string[] = [kind, 'ls'];
    if (kind === 'container') args.push('--all');
    if (owned) args.push('--filter', `label=${RUN_LABEL}=${this.name}`);
    let column = kind === 'container' ? 'Names' : 'Name';
    if (owned && kind !== 'volume') {
      column = 'ID';
      args.push('--no-trunc');
    }
    const { stdout } = await this.docker([...args, '--format', `{{.${column}}}`]);
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  async assertAbsent() {
    for (const kind of kinds) {
      const names = kind === 'container' ? [`${this.name}-valkey`, `${this.name}-client`] : [this.name];
      if (kind === 'volume') names.push(this.emptyVolume);
      requireThat(!(await this.resources(kind)).some((name) => names.includes(name))
        && !(await this.resources(kind, true)).length, `${kind} still exists for ${this.name}`);
    }
  }

  private async cleanup() {
    this.cleaningUp = true; // An interruption must not abort the cleanup commands.
    const errors: string[] = [];
    for (const kind of kinds) {
      try {
        for (const resource of await this.resources(kind, true)) {
          try {
            await this.docker([kind, 'rm', ...(kind === 'container' ? ['--force'] : []), resource]);
          } catch (error) {
            errors.push(String(error));
          }
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      await this.assertAbsent();
    } catch (error) {
      errors.push(String(error));
    }
    requireThat(!errors.length, `Cleanup failed; kept ${this.state}: ${errors.join('; ')}`);
    await rm(this.state, { recursive: true });
    console.log('Cleanup OK: client, Valkey, network, all run volumes and local state absent');
  }

  private async inspect<K extends Kind>(kind: K, name: string): Promise<Inspections[K]> {
    const data: unknown = JSON.parse((await this.docker([kind, 'inspect', name])).stdout);
    requireThat(Array.isArray(data) && data.length === 1 && record(data[0]), `Unexpected Docker ${kind} inspect reply`);
    return data[0] as Inspections[K];
  }

  private async container(role: 'client' | 'valkey') {
    const data = await this.inspect('container', `${this.name}-${role}`);
    const { Networks, Ports } = data.NetworkSettings;
    requireThat(data.Id && data.Config.Labels?.[RUN_LABEL] === this.name && data.State.Running === true,
      `${role} is not a running container of this run`);
    requireThat(Object.keys(Networks).length === 1 && Object.hasOwn(Networks, this.name)
      && !Object.values(Ports ?? {}).some(Boolean), `${role} must be on the run network only, with no published ports`);
    return data;
  }

  private async server() {
    const data = await this.container('valkey');
    const mounts = data.Mounts.filter((mount) => mount.Destination === '/data');
    requireThat(mounts.length === 1 && mounts[0].Type === 'volume' && mounts[0].RW === true,
      'Valkey /data must be a writable volume mount');
    const address = data.NetworkSettings.Networks[this.name].IPAddress;
    requireThat(address, 'Valkey has no internal IPv4 address');
    return { id: data.Id, volume: mounts[0].Name, address, startedAt: data.State.StartedAt };
  }

  private cli(address: string, args: string[], timeout = 10_000) {
    requireThat(this.client, 'Valkey client is not initialized');
    return this.docker(['exec', this.client, 'valkey-cli', '-3', '--json', '-e', '-t', '0.5', '-h', address, ...args],
      { timeout, check: false });
  }

  async verify() {
    console.log(`Run: ${this.name}`);
    await this.assertAbsent();
    await mkdir(join(ROOT, '.runs'), { recursive: true });
    this.signal?.throwIfAborted();
    await mkdir(this.state);
    try {
      await this.scenario();
    } finally {
      await this.cleanup();
    }
    this.signal?.throwIfAborted();
  }

  async scenario() {
    await this.init();
    const variables = [`-var=run_name=${this.name}`, `-var=docker_host=${this.host}`];
    await this.tofu(['apply', '-input=false', '-no-color', '-auto-approve', ...variables], 300_000);

    const network = await this.inspect('network', this.name);
    requireThat(network.Internal === true, 'Docker network must be internal');
    this.client = (await this.container('client')).Id;
    const before = await this.server();
    requireThat(before.volume === this.name, 'Unexpected initial data volume');
    console.log(`Before: id=${before.id} volume=${before.volume} address=${before.address}`);
    requireThat(await ready(before.address, performance.now() + WINDOW,
      (remaining) => this.cli(before.address, ['PING'], remaining)) === 'PONG', 'Expected PONG');

    const expectedConfig = {
      appendonly: 'yes', appendfsync: 'always', dir: '/data',
      appenddirname: 'appendonlydir', appendfilename: 'appendonly.aof', save: '',
    };
    const config = cliReply(await this.cli(before.address, ['CONFIG', 'GET', ...Object.keys(expectedConfig)]));
    requireThat(isDeepStrictEqual(config, expectedConfig), `Unexpected effective Valkey configuration: ${JSON.stringify(config)}`);
    const key = `lab:${this.name}`;
    const value = `synthetic:${randomUUID().replaceAll('-', '')}`;
    requireThat(cliReply(await this.cli(before.address, ['SET', key, value])) === 'OK', 'SET not acknowledged');
    requireThat(cliReply(await this.cli(before.address, ['GET', key])) === value, 'Initial GET did not match');
    await this.docker(['exec', before.id, 'test', '-s', '/data/appendonlydir/appendonly.aof.manifest']);
    await this.docker(['exec', before.id, 'test', '-s', '/data/appendonlydir/appendonly.aof.1.incr.aof']);
    console.log('Before: PONG; AOF/always on the data volume; SET acknowledged and initial GET matched');

    await this.docker(['container', 'rm', '--force', before.id]);
    const down = await this.cli(before.address, ['PING'], 3_000);
    requireThat(connectError(down, before.address),
      `Expected a connection failure from the working client; exit=${down.code}, `
      + `stdout=${JSON.stringify(down.stdout.trim())}, stderr=${JSON.stringify(down.stderr.trim())}`);
    console.log(`Between: ${down.stderr.trim()}`);

    if (this.wrongVolume) {
      requireThat(!(await this.resources('volume')).includes(this.emptyVolume), 'Replacement volume already exists');
      variables.push('-var=wrong_volume=true');
    }
    const plan = 'replacement.tfplan';
    await this.tofu(['plan', '-input=false', '-no-color', `-out=${plan}`, ...variables], 60_000);
    const details: unknown = JSON.parse((await this.tofu(['show', '-json', plan], 15_000)).stdout);
    const creates = validateReplacementPlan(details, this.wrongVolume);
    console.log(`Plan OK: create only ${creates.join(', ')}`);
    await this.tofu(['apply', '-input=false', '-no-color', plan], 60_000);

    const after = await this.server();
    console.log(`After: id=${after.id} volume=${after.volume} address=${after.address}`);
    const expectedVolume = this.wrongVolume ? this.emptyVolume : before.volume;
    requireThat(after.id !== before.id, 'Expected a new Valkey container ID');
    requireThat(after.volume === expectedVolume, `Expected /data on ${expectedVolume}, got ${after.volume}`);
    requireThat((await this.inspect('network', this.name)).Id === network.Id, 'Original network changed');
    for (const volume of new Set([before.volume, expectedVolume])) {
      requireThat((await this.inspect('volume', volume)).Labels?.[RUN_LABEL] === this.name,
        `Volume ${volume} is not labelled for this run`);
    }
    console.log(`After: original volume ${before.volume} still exists`);
    // Compare timestamps from the same engine clock, including Docker Desktop's VM.
    const sampledAt = performance.now();
    const { stdout: engineNow } = await this.docker(['info', '--format', '{{.SystemTime}}']);
    const elapsed = Date.parse(engineNow.trim()) - Date.parse(after.startedAt);
    requireThat(Number.isFinite(elapsed) && elapsed >= 0, 'Invalid Docker engine clock or replacement start time');
    const deadline = sampledAt + WINDOW - elapsed;
    // EVAL_RO executes both commands on one new connection and cannot write.
    const args = ['EVAL_RO', "return {redis.call('PING'), redis.call('GET', KEYS[1])}", '1', key];
    const reply = await ready(after.address, deadline, (remaining) => this.cli(after.address, args, remaining));
    requireRecoveredValue(reply, value);
    const duration = (WINDOW - (deadline - performance.now())) / 1_000;
    console.log(`After: PONG; GET matched the exact pre-replacement value (${duration.toFixed(2)}s / ${WINDOW / 1_000}s)`);
  }
}
