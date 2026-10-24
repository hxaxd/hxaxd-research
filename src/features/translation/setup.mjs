import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const resources = path.join(root, '.runtime/env/translation');
const project = path.join(root, 'src/features/translation');
const data = path.resolve(process.env.APP_DATA_DIR || path.join(root, '.runtime/data'));
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
const configPath = path.join(data, 'translation.json');
const config = {
  ocrRoot: path.join(root, '.runtime/env/ocr'),
  modelsCommand: [process.execPath, path.join(root, 'src/features/models/invoke.mjs'), '--pi-dir', path.join(data, 'pi')],
  texRoot: path.join(root, '.runtime/env/tex'),
  katex: path.join(root, 'node_modules/katex/dist'),
};
await mkdir(data, { recursive: true });
await writeFile(configPath, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ config: configPath,
  python: path.join(resources, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
}));
