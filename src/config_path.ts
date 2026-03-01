import path from 'node:path';
import { resolveDefaultConfigPath } from './config.js';

export function resolveConfigPath(params: {
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): string {
  const fromArg = parseConfigPathArg(params.argv);
  if (fromArg) return path.resolve(fromArg);

  const fromEnv = params.env.GMAIL_CLEANUP_MCP_CONFIG_PATH;
  if (fromEnv) return path.resolve(fromEnv);

  return resolveDefaultConfigPath(params.cwd);
}

function parseConfigPathArg(argv: string[]): string | null {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;

    if (a === '--config' || a === '-c') {
      const v = args[i + 1];
      if (!v) {
        throw new Error(`Missing value for ${a}`);
      }
      return v;
    }

    if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length);
      if (v.length === 0) throw new Error('Missing value for --config');
      return v;
    }
  }
  return null;
}
