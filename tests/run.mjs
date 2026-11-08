import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppConfig } from '../src/app/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const nodeOnly = args[0] === '--node';
const systemVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL',
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemVariables.has(key.toUpperCase())));
env.NEXT_TELEMETRY_DISABLED = '1';
env.PYTHONDONTWRITEBYTECODE = '1';

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const vitest = fileURLToPath(new URL('vitest.mjs', import.meta.resolve('vitest/package.json')));
if (nodeOnly) {
  run(process.execPath, [vitest, 'run', ...args.slice(1)]);
} else {
  const { translationDir } = readAppConfig(root);
  const python = path.join(translationDir, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) throw new Error('Run npm run translation:setup to install the translation test dependencies.');
  run(process.execPath, [vitest, 'run', ...args]);
  run(python, ['-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests/commands', '-v']);
}
