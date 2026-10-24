import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const directory = path.resolve(process.argv[2] ?? '.runtime/dev/translation-check');
const server = createServer(async (request, response) => {
  const file = path.join(directory, new URL(request.url, 'http://localhost').pathname);
  try {
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/translated.html`);
  await page.waitForLoadState('networkidle');
  assert((await page.locator('.katex').count()) > 0, 'Math is rendered');
  assert.equal(await page.locator('.katex-error').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'preview-light.png'), fullPage: true });
  await page.locator('#theme').tap();
  await page.locator('#original').tap();
  assert(await page.locator('.original').first().isVisible());
  await page.screenshot({ path: path.join(directory, 'preview-dark.png'), fullPage: true });
  console.log(JSON.stringify({ math: await page.locator('.katex').count(), errors }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
