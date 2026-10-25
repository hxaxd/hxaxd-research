import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readAppConfig } from '../../server/config.mjs';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const { texDir: texRoot } = readAppConfig(projectRoot);
const texVersion = '0.17.0';
const executable = path.join(texRoot, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
const fonts = path.join(texRoot, 'fonts');

const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc.zip',
  'linux-x64': 'x86_64-unknown-linux-musl.tar.gz',
  'linux-arm64': 'aarch64-unknown-linux-musl.tar.gz',
  'darwin-x64': 'x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'aarch64-apple-darwin.tar.gz',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`暂不支持此 TeX 平台：${process.platform}-${process.arch}`);
await mkdir(fonts, { recursive: true });
async function download(url, destination) {
  if (existsSync(destination)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  console.log(`下载 ${path.basename(destination)}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}
if (!existsSync(executable)) {
  const archive = path.join(texRoot, `tectonic-${texVersion}-${target}`);
  await download(`https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${texVersion}/${path.basename(archive)}`, archive);
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:RESEARCH_TEX_ARCHIVE -DestinationPath $env:RESEARCH_TEX_DESTINATION -Force'], { env: { ...process.env, RESEARCH_TEX_ARCHIVE: archive, RESEARCH_TEX_DESTINATION: texRoot }, stdio: 'inherit' })
    : spawnSync('tar', ['-xzf', archive, '-C', texRoot], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw new Error('TeX 引擎解压失败');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
}
const noto = 'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Serif';
await download(`${noto}/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf`, path.join(fonts, 'NotoSerifCJKsc-Regular.otf'));
await download(`${noto}/LICENSE`, path.join(fonts, 'OFL.txt'));
await writeFile(path.join(texRoot, 'fonts.conf'), '<?xml version="1.0"?><fontconfig><dir prefix="relative">fonts</dir><cachedir prefix="relative">font-cache</cachedir></fontconfig>');
const check = path.join(texRoot, 'check');
await mkdir(check, { recursive: true });
await writeFile(path.join(check, 'main.tex'), String.raw`\documentclass{article}
\usepackage{amsmath,graphicx,natbib,xeCJK}
\setCJKmainfont{NotoSerifCJKsc-Regular.otf}
\begin{document}
Project TeX / 项目独立编译。 $E=mc^2$
\end{document}
`);
const result = spawnSync(executable, [
  '-b', 'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar', '-Z', `search-path=${fonts}`,
  '--keep-logs', '--synctex', 'main.tex',
], { cwd: check, stdio: 'inherit', env: { ...process.env,
  TECTONIC_CACHE_DIR: path.join(texRoot, 'cache'), FONTCONFIG_FILE: path.join(texRoot, 'fonts.conf'),
} });
if (result.error) throw result.error;
if (result.status) throw new Error('TeX 基础资源预热失败，请查看编译输出后重试 npm run tex:setup');
console.log(`项目 TeX ${texVersion} 已就绪：${texRoot}`);
