import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';

import { pdfFixture } from '../pdf-fixture';

test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } });

async function selectText(locator: Locator) {
  await locator.evaluate(element => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
}

test('all text readers quote selections with source, view mode and PDF page into native conversation history', async ({ page, request }) => {
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const otherId = randomUUID();
  const base = `/api/workspaces/${workspaceId}`;
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '引用工作区' } });
  await request.post(`${base}/conversations`, { data: { id: conversationId, name: '引用提问' } });
  await request.post(`${base}/conversations`, { data: { id: otherId, name: '另一个对话' } });
  const content = {
    'guide.md': '# 阅读笔记\n\nRendered Markdown source alpha.',
    'article.html': '<!doctype html><html><body><p>Rendered HTML source beta.</p></body></html>',
    'notes.txt': 'Plain text source gamma.',
    'main.tex': '\\documentclass{article}\nTeX source delta.',
  };
  for (const [name, text] of Object.entries(content)) {
    const imported = await request.post(`${base}/imports`, { multipart: {
      metadata: JSON.stringify({ target: '' }), file: { name, mimeType: 'text/plain', buffer: Buffer.from(text) },
    } });
    expect(imported.status()).toBe(201);
  }
  await request.post(`${base}/imports`, { multipart: {
    metadata: JSON.stringify({ target: '' }), pdf: { name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdfFixture(2) },
  } });
  async function openFile(name: string) {
    await page.getByRole('button', { name: '展开材料栏', exact: true }).tap();
    await page.getByRole('button', { name, exact: true }).tap();
  }
  await page.goto(`/workspaces/${workspaceId}?file=guide.md&conversation=${conversationId}`);
  const draft = page.getByLabel('待发送引用');
  await selectText(page.locator('.document-markdown p'));
  await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  await expect(draft.locator('.quote-card')).toHaveCount(1);
  await page.getByRole('button', { name: '源码', exact: true }).tap();
  await selectText(page.locator('.text-preview pre'));
  await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  await expect(draft).toContainText('源码');

  await openFile('article.html');
  await selectText(page.frameLocator('iframe[title="HTML 预览"]').locator('p'));
  await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  await page.getByRole('button', { name: '源码', exact: true }).tap();
  await selectText(page.locator('.text-preview pre'));
  await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  for (const name of ['notes.txt', 'main.tex']) {
    await openFile(name);
    await selectText(page.locator('.text-preview pre'));
    await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  }
  await openFile('paper.pdf');
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  await page.getByLabel('跳转页码').fill('2');
  await page.getByLabel('跳转页码').press('Enter');
  await expect(page.locator('.page[data-page-number="2"] .textLayer')).toContainText('page 2');
  await selectText(page.locator('.page[data-page-number="2"] .textLayer span').first());
  await page.getByRole('button', { name: '引用选段', exact: true }).tap();
  await expect(draft.locator('.quote-card')).toHaveCount(7);
  await expect(draft).toContainText('第 2 页');
  await page.screenshot({ path: '.runtime/dev/text-quotes-light.png', animations: 'disabled' });
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).tap();
  await page.screenshot({ path: '.runtime/dev/text-quotes-dark.png', animations: 'disabled' });
  await page.getByRole('combobox', { name: '切换对话', exact: true }).tap();
  await page.getByRole('option', { name: '另一个对话', exact: true }).tap();
  await expect(draft).toHaveCount(0);
  await page.getByRole('combobox', { name: '切换对话', exact: true }).tap();
  await page.getByRole('option', { name: '引用提问', exact: true }).tap();
  await expect(draft.locator('.quote-card')).toHaveCount(7);
  await page.getByRole('combobox', { name: '选择模型', exact: true }).tap();
  await page.getByRole('option', { name: '纯文本模型', exact: true }).tap();
  await page.getByLabel('对话消息').fill('[QUOTES]');
  await page.route('**/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '发送暂时失败' } }) }), { times: 1 });
  await page.getByRole('button', { name: '发送消息' }).tap();
  await expect(page.getByRole('alert').filter({ hasText: '发送暂时失败' })).toBeVisible();
  await expect(draft.locator('.quote-card')).toHaveCount(7);
  await page.getByRole('button', { name: '发送消息' }).tap();
  await expect(page.locator('.chat-message.assistant')).toContainText('收到 7 段引用');
  await expect(draft).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('引用原文').locator('.quote-card')).toHaveCount(7);
  await expect(page.locator('.chat-message.user .markdown')).toHaveText('[QUOTES]');
  await page.getByLabel('引用原文').locator('.quote-card').nth(1).tap();
  await expect(page.locator('.resource-name')).toHaveText('guide.md');
  await expect(page.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const snapshot = await (await request.get(`${base}/conversations/${conversationId}`)).json();
  expect(snapshot.messages.find((message: { role: string }) => message.role === 'user').quotes.at(-1)).toMatchObject({ path: 'paper.pdf', page: 2 });
});

test('images can be quoted whole or cropped with touch and sent with their source', async ({ page, request }) => {
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const base = `/api/workspaces/${workspaceId}`;
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '图片引用' } });
  await request.post(`${base}/conversations`, { data: { id: conversationId, name: '图像提问' } });
  await request.post(`${base}/imports`, { multipart: { metadata: JSON.stringify({ target: '' }),
    image: { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180"><rect width="360" height="180" fill="royalblue"/></svg>') },
  } });
  await page.goto(`/workspaces/${workspaceId}?file=diagram.svg&conversation=${conversationId}`);
  await expect.poll(() => page.getByAltText('diagram.svg').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(360);
  await page.getByRole('button', { name: '引用图片', exact: true }).tap();
  await page.getByRole('button', { name: '框选引用', exact: true }).tap();
  const overlay = page.getByLabel('图片框选区域');
  await overlay.tap({ position: { x: 20, y: 20 } });
  await overlay.tap({ position: { x: 170, y: 90 } });
  await page.getByRole('button', { name: '加入提问', exact: true }).tap();
  await expect(page.getByLabel('待发送截图').locator('img')).toHaveCount(2);
  await page.screenshot({ path: '.runtime/dev/image-quotes.png' });
  await page.getByRole('combobox', { name: '选择模型', exact: true }).tap();
  await page.getByRole('option', { name: '测试模型', exact: true }).tap();
  await page.getByLabel('对话消息').fill('[IMAGE]');
  await page.getByRole('button', { name: '发送消息' }).tap();
  await expect(page.locator('.chat-message.assistant')).toContainText('收到 2 张截图；PNG：true');
  await expect(page.locator('.chat-message.assistant')).toContainText('image-region');
  await expect(page.locator('.chat-message.assistant')).toContainText('diagram.svg');
});
