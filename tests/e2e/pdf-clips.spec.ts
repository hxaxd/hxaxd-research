import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { pdfFixture } from '../pdf-fixture';

test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } });

test('touch PDF clips become image context, survive a failed send and remain visible in history', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const workspaceId = randomUUID();
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '触屏截图' } });
  await request.post(`/api/workspaces/${workspaceId}/imports`, { multipart: {
    metadata: JSON.stringify({ target: '' }),
    file: { name: 'article.pdf', mimeType: 'application/pdf', buffer: pdfFixture(3) },
  } });
  await page.goto(`/workspaces/${workspaceId}?file=article.pdf`);
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  await page.getByRole('button', { name: '下一页', exact: true }).tap();
  await expect(page.getByLabel('跳转页码')).toHaveValue('2');
  await page.getByRole('button', { name: '页面反色' }).tap();
  const select = page.getByRole('button', { name: '框选提问', exact: true });
  expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await select.tap();
  const bounds = (await page.locator('.page[data-page-number="2"]').boundingBox())!;
  await page.touchscreen.tap(bounds.x + 20, bounds.y + 25);
  await page.touchscreen.tap(bounds.x + bounds.width - 20, bounds.y + 200);
  await page.getByRole('button', { name: '加入提问', exact: true }).tap();
  const draft = page.getByLabel('待发送截图');
  await expect(draft.getByRole('button', { name: '查看article.pdf · 第 2 页' })).toBeVisible();
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  expect(conversationId).toBeTruthy();
  const image = draft.locator('img');
  await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  expect(await image.evaluate(image => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(image as HTMLImageElement, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  })).toEqual([255, 255, 255, 255]);
  await draft.getByRole('button', { name: '查看article.pdf · 第 2 页' }).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  expect((await page.getByRole('dialog').boundingBox())!.width).toBeGreaterThan(800);
  await page.screenshot({ path: '.runtime/dev/pdf-clip-preview-light.png' });
  await page.getByRole('button', { name: '关闭截图预览' }).tap();
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).tap();

  await select.tap();
  await page.getByRole('button', { name: '取消', exact: true }).tap();
  await expect(page.getByLabel('PDF 框选区域')).toHaveCount(0);
  await page.getByRole('button', { name: '上一页', exact: true }).tap();
  await select.tap();
  const first = (await page.locator('.page[data-page-number="1"]').boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x + 20, y: first.y + 25, id: 0 }] });
  for (let step = 1; step <= 8; step++) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: first.x + 20 + (first.width - 40) * step / 8, y: first.y + 25 + 175 * step / 8, id: 0 }] });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.screenshot({ path: '.runtime/dev/pdf-clip-selection-dark.png' });
  await page.getByRole('button', { name: '加入提问', exact: true }).tap();
  await expect(page.getByLabel('PDF 框选区域')).toHaveCount(0);
  await touch.detach();
  await expect(draft.locator('.composer-clip')).toHaveCount(2);
  await page.getByRole('button', { name: '新建对话', exact: true }).tap();
  await page.getByLabel('名称', { exact: true }).fill('另一段讨论');
  await page.getByRole('button', { name: '保存', exact: true }).tap();
  await expect(draft).toHaveCount(0);
  await page.getByRole('combobox', { name: '切换对话', exact: true }).tap();
  await page.getByRole('option', { name: '材料提问', exact: true }).tap();
  await expect(draft.locator('.composer-clip')).toHaveCount(2);
  await page.getByRole('combobox', { name: '选择模型', exact: true }).tap();
  await page.getByRole('option', { name: '纯文本模型', exact: true }).tap();
  await expect(page.getByText('当前模型不支持图片，请切换模型后发送。')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await page.getByRole('combobox', { name: '选择模型', exact: true }).tap();
  await page.getByRole('option', { name: '测试模型', exact: true }).tap();
  await page.getByLabel('对话消息').fill('[IMAGE]');
  await page.route('**/messages', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '发送暂时失败' } }) }), { times: 1 });
  await page.getByRole('button', { name: '发送消息' }).tap();
  await expect(page.getByRole('alert').filter({ hasText: '发送暂时失败' })).toBeVisible();
  await expect(draft.locator('.composer-clip')).toHaveCount(2);
  await page.getByRole('button', { name: '发送消息' }).tap();
  await expect(page.locator('.conversation-messages')).toContainText('收到 2 张截图；PNG：true');
  await expect(page.locator('.chat-message.assistant')).toContainText('"page":2');
  await expect(page.locator('.chat-message.assistant')).toContainText('"page":1');
  await expect(page.locator('.chat-message.user .markdown')).toHaveText('[IMAGE]');
  await expect(draft).toHaveCount(0);
  await page.reload();
  const saved = page.locator('.message-images img');
  await expect(saved).toHaveCount(2);
  await expect(page.locator('.chat-message.user .markdown')).toHaveText('[IMAGE]');
  await expect.poll(() => saved.first().evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  const snapshot = await (await request.get(`/api/workspaces/${workspaceId}/conversations/${conversationId}`)).json();
  expect(JSON.stringify(snapshot)).not.toContain('iVBOR');
  const imageResponse = await request.get(snapshot.messages.find((message: { role: string }) => message.role === 'user').images[0].url);
  expect(imageResponse.headers()['content-type']).toBe('image/png');
  expect(imageResponse.status()).toBe(200);
  expect(errors).toEqual([]);
});
