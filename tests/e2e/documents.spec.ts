import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('Markdown and HTML preview local assets, switch source views and let Pi open the resulting document', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '文档工作区' } });
  const base = `/api/workspaces/${workspaceId}`;
  await request.post(`${base}/conversations`, { data: { id: conversationId, name: '文档制作' } });
  await page.context().route('https://example.com/preview-data', route => route.fulfill({
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ value: '外部数据' }),
  }));
  await page.context().route('https://example.com/submit', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>表单已提交</h1>' }));
  await page.context().route('https://example.com/app', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>应用已打开</h1>' }));
  const content: Record<string, string> = {
    'guide.md': '# 阅读笔记\n\n| 方法 | 结果 |\n| --- | --- |\n| TeX | PDF |\n\n$E=mc^2$，\\(a_i+b_i\\)\n\n$$\nx^2+y^2=z^2\n$$\n\n\\[\\frac{1}{2}\\]\n\n`\\(保留代码\\)`\n\n![示意图](diagram.svg)\n\n[打开面板](panel/index.html)',
    'diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="royalblue"/></svg>',
    'panel/index.html': '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><h1>本地材料面板</h1><button id="counter">0</button><output id="data"></output><form method="post" action="https://example.com/submit" target="submitted"><input name="message" value="hello"><button>提交</button></form><iframe name="submitted" title="表单结果"></iframe><a href="https://example.com/app" target="_blank" rel="noopener noreferrer">打开链接</a><script src="panel.js"></script></body></html>',
    'panel/theme.css': 'h1 { color: rgb(22, 120, 88); }',
    'panel/data.json': JSON.stringify({ value: '本地数据' }),
    'panel/panel.js': `
      let count = Number(localStorage.getItem('document-counter') ?? '0');
      const counter = document.querySelector('#counter');
      counter.textContent = String(count);
      counter.onclick = () => {
        localStorage.setItem('document-counter', String(++count));
        counter.textContent = String(count);
      };
      Promise.all(['./data.json', 'https://example.com/preview-data'].map(url => fetch(url).then(response => response.json())))
        .then(values => { document.querySelector('#data').textContent = values.map(data => data.value).join(' / '); });
    `,
  };
  const result = await request.post(`${base}/imports`, { multipart: {
    metadata: JSON.stringify({ target: '', folderName: 'documents' }),
    ...Object.fromEntries(Object.entries(content).map(([name, text], index) => [`file${index}`, { name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) }])),
  } });
  expect(result.status()).toBe(201);
  await page.goto(`/workspaces/${workspaceId}?file=documents/guide.md&conversation=${conversationId}`);
  await expect(page.locator('.document-markdown').getByRole('heading', { name: '阅读笔记' })).toBeVisible();
  await expect(page.locator('.document-markdown table')).toContainText('PDF');
  await expect(page.locator('.document-markdown .katex')).toHaveCount(4);
  await expect(page.locator('.document-markdown .katex-display')).toHaveCount(2);
  await expect(page.locator('.document-markdown code')).toHaveText('\\(保留代码\\)');
  await expect.poll(() => page.getByAltText('示意图').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(120);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.text-preview')).toContainText('# 阅读笔记');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('link', { name: '打开面板', exact: true }).click();
  const frame = page.frameLocator('iframe[title="HTML 预览"]');
  await expect(frame.getByRole('heading', { name: '本地材料面板' })).toBeVisible();
  await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(22, 120, 88)');
  await frame.getByRole('button', { name: '0', exact: true }).click();
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await expect(frame.locator('#data')).toHaveText('本地数据 / 外部数据');
  await page.getByRole('button', { name: '重新读取当前文件', exact: true }).click();
  await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible();
  const submissionReady = page.waitForRequest('https://example.com/submit');
  await frame.getByRole('button', { name: '提交', exact: true }).click();
  expect((await submissionReady).postData()).toBe('message=hello');
  await expect(frame.frameLocator('iframe[title="表单结果"]').getByRole('heading', { name: '表单已提交' })).toBeVisible();
  const htmlPopupReady = page.waitForEvent('popup');
  await frame.getByRole('link', { name: '打开链接', exact: true }).click();
  const htmlPopup = await htmlPopupReady;
  await expect(htmlPopup.getByRole('heading', { name: '应用已打开' })).toBeVisible();
  await htmlPopup.close();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.locator('.text-preview')).toContainText('panel.js');
  await page.getByRole('combobox', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: '测试模型', exact: true }).click();
  await page.getByLabel('对话消息').fill('[OPEN]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText('已读取文档技能并请求展示 documents/guide.md');
  await expect(page.locator('.resource-name')).toHaveText('guide.md');
  await expect(page.locator('.document-markdown').getByRole('heading', { name: '阅读笔记' })).toBeVisible();
  await expect(page.getByLabel('当前阅读材料')).toContainText('guide.md');
  const messages = page.locator('.chat-message.assistant');
  await expect(messages.locator('.katex')).toHaveCount(4);
  await expect(messages.locator('.katex-display')).toHaveCount(2);
  await expect(messages.locator('.katex-error')).toHaveCount(0);
  await mkdir('.runtime/dev/screenshots', { recursive: true });
  await page.screenshot({ path: '.runtime/dev/screenshots/math-preview.png', animations: 'disabled' });
  await expect(messages.getByRole('link', { name: 'http://localhost:3000/' })).toHaveAttribute('href', 'http://localhost:3000/');
  const workspaceUrl = page.url();
  const popupReady = page.waitForEvent('popup');
  await messages.getByRole('link', { name: '打开应用', exact: true }).click();
  const popup = await popupReady;
  await expect(popup.getByRole('heading', { name: '应用已打开' })).toBeVisible();
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await expect(page).toHaveURL(workspaceUrl);
  await popup.close();
  expect(errors).toEqual([]);
});
