import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { pdfFixture } from '../pdf-fixture';

test('PDF reading scrolls, navigates outlines, resizes, inverts and follows the active file in model context', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const workspaceId = randomUUID();
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '阅读体验' } });
  const conversationId = randomUUID();
  const base = `/api/workspaces/${workspaceId}`;
  await request.post(`${base}/conversations`, { data: { id: conversationId, name: '论文阅读' } });
  for (const name of ['first.pdf', 'second.pdf']) {
    const result = await request.post(`${base}/imports`, { multipart: {
      metadata: JSON.stringify({ target: '' }),
      file: { name, mimeType: 'application/pdf', buffer: pdfFixture(3) },
    } });
    expect(result.status()).toBe(201);
  }
  await page.goto(`/workspaces/${workspaceId}?file=first.pdf&conversation=${conversationId}`);
  const pageNumber = page.getByLabel('跳转页码');
  const reader = page.getByLabel('PDF 页面', { exact: true });
  const current = page.getByLabel('当前阅读材料');
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  await expect(current).toContainText('first.pdf');
  await page.getByLabel('选择模型', { exact: true }).click();
  await page.getByRole('option', { name: '测试模型', exact: true }).click();
  await reader.hover();
  await page.mouse.wheel(0, 800);
  await expect(pageNumber).toHaveValue('2');
  await expect(current).toContainText('第 2 页');
  await page.getByLabel('对话消息').fill('[READING]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText('当前文件：first.pdf；当前页码：2');

  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '文档目录' }).getByRole('button', { name: 'Section 3', exact: true }).click();
  await expect(pageNumber).toHaveValue('3');
  await expect(current).toContainText('第 3 页');
  await expect(page.locator('.page[data-page-number="3"] .textLayer')).toContainText('page 3');
  await pageNumber.fill('1');
  await pageNumber.press('Enter');
  await expect(pageNumber).toHaveValue('1');

  await page.getByRole('combobox', { name: '阅读方式' }).click();
  await page.getByRole('option', { name: '单页', exact: true }).click();
  await page.getByRole('combobox', { name: '阅读缩放' }).click();
  await page.getByRole('option', { name: '适应页面', exact: true }).click();
  await reader.hover();
  await page.mouse.wheel(0, 120);
  await expect(pageNumber).toHaveValue('2');
  await pageNumber.fill('3');
  await pageNumber.press('Enter');
  await reader.hover();
  await page.mouse.wheel(0, 120);
  await expect(pageNumber).toHaveValue('3');

  await page.getByRole('button', { name: '页面反色' }).click();
  await expect(page.getByRole('button', { name: '页面反色' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'second.pdf', exact: true }).click();
  await expect(current).toContainText('second.pdf');
  await expect(pageNumber).toHaveValue('1');
  await expect(page.getByRole('button', { name: '页面反色' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('对话消息').fill('[READING]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText('当前文件：second.pdf；当前页码：1');
  await page.getByRole('combobox', { name: '阅读缩放' }).click();
  await page.getByRole('option', { name: '适应宽度', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => reader.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('combobox', { name: '阅读缩放' }).click();
  await page.getByRole('option', { name: '200%', exact: true }).click();
  await expect.poll(() => reader.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(pageNumber).toHaveValue('1');
  await page.getByRole('combobox', { name: '阅读缩放' }).click();
  await page.getByRole('option', { name: '适应页面', exact: true }).click();
  await page.getByRole('button', { name: '框选提问', exact: true }).click();
  const bounds = (await page.locator('.page[data-page-number="1"]').boundingBox())!;
  await page.mouse.move(bounds.x + 15, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 15, bounds.y + 130, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: '加入提问', exact: true }).click();
  await expect(page.getByLabel('待发送截图').locator('img')).toBeVisible();
  await page.getByRole('button', { name: '移除截图 1' }).click();
  await expect(page.getByLabel('待发送截图')).toHaveCount(0);
  expect(errors).toEqual([]);
});
