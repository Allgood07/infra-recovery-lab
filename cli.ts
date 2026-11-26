import { run } from './command.ts';
import { Lab, localDocker } from './verify.ts';

async function main(args: string[]) {
  const usage = 'Usage: node cli.ts [--wrong-volume]';
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length && (args.length !== 1 || args[0] !== '--wrong-volume')) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error('Interrupted by SIGINT'));
  const onTerminate = () => controller.abort(new Error('Interrupted by SIGTERM'));
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const host = await localDocker(process.env, run, undefined, controller.signal);
    await new Lab(host, args[0] === '--wrong-volume', process.env, run, controller.signal).verify();
  } catch (error) {
    console.error(`verify: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

await main(process.argv.slice(2));
