import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppConfig } from '../../server/config.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { translationDir: resources } = readAppConfig(root);
const project = path.join(root, 'src/features/translation');
const environment = { ...process.env,
  UV_PROJECT_ENVIRONMENT: path.join(resources, 'python'),
  UV_CACHE_DIR: path.join(resources, 'cache'),
  UV_PYTHON_INSTALL_DIR: path.join(resources, 'interpreters'),
  UV_PYTHON_BIN_DIR: path.join(resources, 'bin'),
};
await mkdir(resources, { recursive: true });
function execute(args, capture = false) {
  const result = spawnSync('uv', args, { env: environment, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`翻译环境安装失败：${capture ? result.stderr : result.status}`);
  return result.stdout?.trim();
}
execute(['python', 'install', '3.12.10']);
const interpreter = execute(['python', 'find', '--managed-python', '3.12.10'], true);
execute(['sync', '--project', project, '--locked', '--python', interpreter]);
console.log(JSON.stringify({
  python: path.join(resources, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
}));
