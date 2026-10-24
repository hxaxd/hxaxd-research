import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ocrRoot = path.join(projectRoot, '.runtime/env/ocr');
const ocrModel = 'PaddleOCR-VL-1.6';
const uvVersion = '0.12.22';

function linuxPath(value) {
  const absolute = path.resolve(value);
  if (process.platform !== 'win32') return absolute;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) throw new Error(`WSL 入口需要本机磁盘路径：${absolute}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function runLinux(distro, command, args, capture = false) {
  const result = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-d', distro, '--', command, ...args], { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OCR 命令退出 ${result.status}：${capture ? result.stderr : command}`);
  return result.stdout?.trim();
}

const { values } = parseArgs({ options: {
  distro: { type: 'string', default: 'Ubuntu' }, device: { type: 'string', default: 'gpu:0' },
} });
if (process.platform !== 'win32' && (process.platform !== 'linux' || process.arch !== 'x64'))
  throw new Error('OCR 安装当前支持 Linux x64 和 Windows WSL Linux x64');
if (values.device !== 'cpu' && !/^gpu:\d+$/.test(values.device)) throw new Error('--device 使用 cpu 或 gpu:编号');
const distro = values.distro;
if (runLinux(distro, 'uname', ['-m'], true) !== 'x86_64') throw new Error('OCR 运行环境需要 Linux x64');
const tools = path.join(ocrRoot, 'tools');
await mkdir(tools, { recursive: true });
const uv = path.join(tools, 'uv-x86_64-unknown-linux-gnu/uv');
if (!existsSync(uv)) {
  const archive = path.join(tools, `uv-${uvVersion}.tar.gz`);
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-x86_64-unknown-linux-gnu.tar.gz`);
  if (!response.ok) throw new Error(`uv 下载失败：${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  runLinux(distro, 'tar', ['-xzf', linuxPath(archive), '-C', linuxPath(tools)]);
}
const runtime = linuxPath(ocrRoot);
const environment = [
  `UV_PROJECT_ENVIRONMENT=${runtime}/python`, `UV_CACHE_DIR=${runtime}/cache/uv`,
  `UV_PYTHON_INSTALL_DIR=${runtime}/interpreters`, `UV_LINK_MODE=copy`, `UV_PYTHON_BIN_DIR=${runtime}/bin`,
  `XDG_CACHE_HOME=${runtime}/cache`, `XDG_CONFIG_HOME=${runtime}/config`,
  `PYTHONPYCACHEPREFIX=${runtime}/cache/pycache`,
  `PADDLE_PDX_CACHE_HOME=${runtime}/models/paddlex`, `PADDLE_HOME=${runtime}/models/paddle`,
  `HF_HOME=${runtime}/models/huggingface`, `MODELSCOPE_CACHE=${runtime}/models/modelscope`,
  `MPLCONFIGDIR=${runtime}/config/matplotlib`, `PADDLE_PDX_MODEL_SOURCE=BOS`,
  `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`,
];
runLinux(distro, 'env', [...environment, linuxPath(uv), 'python', 'install', '3.12.10']);
const interpreter = runLinux(distro, 'env', [...environment, linuxPath(uv), 'python', 'find', '--managed-python', '3.12.10'], true);
runLinux(distro, 'env', [...environment, linuxPath(uv), 'sync', '--project', linuxPath(path.join(projectRoot, 'src/features/ocr')),
  '--locked', '--python', interpreter, '--extra', values.device === 'cpu' ? 'cpu' : 'gpu']);
const python = `${linuxPath(ocrRoot)}/python/bin/python`;
runLinux(distro, 'env', [...environment, python, '-c',
  `from paddleocr import PaddleOCRVL; model = PaddleOCRVL(pipeline_version='v1.6', device='${values.device}', use_doc_orientation_classify=False, use_doc_unwarping=False, merge_layout_blocks=False, use_queues=False); model.close()`]);
const command = [
  ...(process.platform === 'win32' ? ['wsl.exe', '-d', distro, '--'] : []),
  'env', ...environment, python, '-m', 'paddleocr', 'doc_parser', '--pipeline_version', 'v1.6',
  '--device', values.device, '--use_doc_orientation_classify', 'false', '--use_doc_unwarping', 'false',
  '--merge_layout_blocks', 'false', '--use_queues', 'false',
];
await writeFile(path.join(ocrRoot, 'installation.json'), JSON.stringify({ model: ocrModel, distro, device: values.device, command }, null, 2));
console.log(JSON.stringify({ root: ocrRoot, model: ocrModel, device: values.device }));
