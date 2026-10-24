import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { pdfFixture } from '../pdf-fixture';

test('workspace, paper, directory import, PDF reading, Pi editing, conversations and reconnect', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const initialUrl = page.url();
  if (new URL(page.url()).pathname !== '/') {
    await page.getByRole('button', { name: '切换工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建工作区', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
  }
  await page.getByLabel('名称', { exact: true }).fill('研究草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).not.toHaveURL(initialUrl);
  await expect(page).toHaveURL(/\/workspaces\//);
  const workspaceId = new URL(page.url()).pathname.split('/').pop()!;
  const nameWidth = (await page.locator('.workspace-name').boundingBox())!
    .width;
  const longName = '面向多模态科研材料与论文实验的长期研究工作区'.repeat(3);
  await page.getByRole('button', { name: '研究草稿', exact: true }).click();
  await page.getByLabel('工作区名称', { exact: true }).fill(longName);
  expect((await page.locator('.workspace-name').boundingBox())!.width).toBe(
    nameWidth,
  );
  await page.getByLabel('工作区名称', { exact: true }).press('Enter');
  const longTitle = page.getByRole('button', { name: longName, exact: true });
  await expect(longTitle).toBeVisible();
  expect(
    await longTitle.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await longTitle.click();
  await page.getByLabel('工作区名称', { exact: true }).fill('可复现研究');
  await page.getByLabel('工作区名称', { exact: true }).press('Enter');
  await expect(
    page.getByRole('button', { name: '可复现研究', exact: true }),
  ).toBeVisible();
  expect((await page.locator('.workspace-name').boundingBox())!.width).toBe(
    nameWidth,
  );
  await page.getByRole('button', { name: '新建论文', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('一个完整的论文工程');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '一个完整的论文工程', exact: true }),
  ).toBeVisible();
  const papers = await (
    await request.get(`/api/workspaces/${workspaceId}/papers`)
  ).json();
  const paperId = papers[0].id as string;
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  await page.getByLabel('选择材料文件').setInputFiles({
    name: 'article.pdf',
    mimeType: 'application/pdf',
    buffer: pdfFixture(),
  });
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: 'article.pdf', exact: true }).click();
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  expect(
    await page
      .locator('.reader-panel canvas')
      .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
  ).toBeGreaterThan(0);
  const imported = await request.post(
    `/api/workspaces/${workspaceId}/imports`,
    {
      multipart: {
        metadata: JSON.stringify({
          target: `papers/${paperId}`,
          folderName: 'source',
        }),
        first: {
          name: 'main.tex',
          mimeType: 'text/plain',
          buffer: Buffer.from('\\input{sections/body.tex}'),
        },
        second: {
          name: 'sections/body.tex',
          mimeType: 'text/plain',
          buffer: Buffer.from('A reproducible result.'),
        },
      },
    },
  );
  expect(imported.status()).toBe(201);
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await page.getByRole('button', { name: 'source', exact: true }).click();
  await page.getByRole('button', { name: 'main.tex', exact: true }).click();
  await expect(page.locator('.text-preview')).toContainText(
    'sections/body.tex',
  );
  const note = await request.post(`/api/workspaces/${workspaceId}/imports`, {
    multipart: {
      metadata: JSON.stringify({ target: '' }),
      file: {
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('alpha'),
      },
    },
  });
  expect(note.status()).toBe(201);
  await page.context().route('https://auth.openai.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>ChatGPT authorization preview</title>',
    }),
  );
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const providerDialog = page.getByRole('dialog', {
    name: '设置',
    exact: true,
  });
  await expect(
    providerDialog.getByRole('button', { name: '模型', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const popupOpened = page.waitForEvent('popup');
  await providerDialog
    .getByRole('button', { name: '用 ChatGPT 登录', exact: true })
    .click();
  const authorizationPage = await popupOpened;
  await expect(authorizationPage).toHaveURL(
    /https:\/\/auth\.openai\.com\/api\/accounts\/authorize/,
  );
  expect(
    new URL(authorizationPage.url()).searchParams.get('agent_name_hint'),
  ).toBe('hxaxd Research');
  await authorizationPage.close();
  await expect(
    providerDialog.getByText('等待在浏览器中完成授权…', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(
    providerDialog.getByText('等待在浏览器中完成授权…', { exact: true }),
  ).toBeVisible();
  await providerDialog
    .getByRole('button', { name: '取消授权', exact: true })
    .click();
  await expect(providerDialog.getByText('已取消授权', { exact: true })).toBeVisible();
  await mkdir('.runtime/dev/screenshots', { recursive: true });
  await page.screenshot({
    path: '.runtime/dev/screenshots/model-providers.png',
    animations: 'disabled',
  });
  await providerDialog
    .getByRole('button', { name: '关闭设置', exact: true })
    .click();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('讨论 A');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('combobox', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: '测试模型', exact: true }).click();
  await expect(page.getByLabel('当前阅读材料')).toContainText('main.tex');
  await page.getByLabel('对话消息').fill('[EDIT]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText(
    '已读取并修改 note.txt',
  );
  await page.getByLabel('对话消息').fill('[WORKSPACE]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText('已生成');
  await page.getByRole('button', { name: 'analysis', exact: true }).click();
  await page
    .getByRole('button', { name: 'summary.custom', exact: true })
    .click();
  await page.getByRole('button', { name: '以文本预览', exact: true }).click();
  await expect(page.locator('.text-preview')).toContainText('可复现研究');
  await expect(page.locator('.text-preview')).toContainText(
    '一个完整的论文工程',
  );
  const configFile = path.join(
    process.env.RESEARCH_E2E_DATA!,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const workspaceConfig = JSON.parse(await readFile(configFile, 'utf8'));
  workspaceConfig.name = '文件配置中的研究';
  workspaceConfig.papers[0].name = '文件配置中的论文';
  await writeFile(configFile, JSON.stringify(workspaceConfig));
  await expect(
    page.getByRole('button', { name: '文件配置中的研究', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '文件配置中的论文', exact: true }),
  ).toBeVisible();
  const paperDirectory = workspaceConfig.papers[0].path;
  workspaceConfig.papers[0].path = `${paperDirectory}/source`;
  await writeFile(configFile, JSON.stringify(workspaceConfig));
  await expect(
    page.getByRole('button', { name: 'main.tex', exact: true }),
  ).toBeVisible();
  workspaceConfig.papers[0].path = paperDirectory;
  await writeFile(configFile, JSON.stringify(workspaceConfig));
  await expect(
    page.getByRole('button', { name: 'article.pdf', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('讨论 B');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '讨论 B', exact: true }),
  ).toBeVisible();
  await page.getByLabel('对话消息').fill('[SLOW]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText('片段');
  await page.reload();
  await expect(
    page.getByRole('button', { name: '停止回答', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '停止回答', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '停止回答', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('combobox', { name: '切换对话', exact: true }).click();
  await page.getByRole('option', { name: '讨论 A', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText(
    '已读取并修改 note.txt',
  );
  await page.getByRole('button', { name: 'article.pdf', exact: true }).click();
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  const restoredUrl = page.url();
  await page.goto('/');
  await expect(page).toHaveURL(restoredUrl);
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');

  await page.getByLabel('对话消息').fill('[LAYOUT]');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.markdown table')).toContainText('论文原文');

  const bench = (await page.locator('.workbench').boundingBox())!;
  const handle = page.getByRole('separator', { name: '调整对话栏宽度' });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 180);
  await page.mouse.down();
  await page.mouse.move(bench.x + bench.width - 100, grip.y + 180, {
    steps: 8,
  });
  await expect(handle).toHaveAttribute('aria-valuenow', '300');
  expect(
    await page
      .locator('.conversation-messages')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator('.markdown pre')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await page.mouse.move(bench.x + bench.width - 70, grip.y + 180);
  await expect(handle).toHaveAttribute('aria-valuenow', '300');
  await page.mouse.move(bench.x + bench.width - 20, grip.y + 180);
  await expect(page.locator('.conversation-panel')).toHaveClass(
    /collapse-pending/,
  );
  await page.mouse.up();
  await expect(page.locator('.conversation-panel')).not.toBeVisible();
  await page.getByRole('button', { name: '展开对话栏', exact: true }).click();
  await expect(page.locator('.conversation-messages')).toContainText(
    '已读取并修改 note.txt',
  );
  await handle.focus();
  await handle.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '400');
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  await page.locator('.resource-name').click();
  await mkdir('.runtime/dev/screenshots', { recursive: true });
  await page.screenshot({
    path: '.runtime/dev/screenshots/workbench-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute(
    'data-palette',
    'graphite',
  );
  await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
  await page.screenshot({
    path: '.runtime/dev/screenshots/workbench-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const darkSettings = settings.getByRole('group', {
    name: '暗色模式',
    exact: true,
  });
  const lightSettings = settings.getByRole('group', {
    name: '浅色模式',
    exact: true,
  });
  await darkSettings.getByText('Nord', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord');
  await darkSettings.getByText('自定义 CSS', { exact: true }).click();
  await darkSettings.getByLabel('导入暗色 CSS', { exact: true }).setInputFiles({
    name: 'custom.css',
    mimeType: 'text/css',
    buffer: Buffer.from(':root { --accent: #f0abfc; }'),
  });
  await expect(
    darkSettings.getByLabel('暗色 CSS', { exact: true }),
  ).toHaveValue(':root { --accent: #f0abfc; }');
  await darkSettings
    .getByRole('button', { name: '应用 CSS', exact: true })
    .click();
  const accent = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim(),
    );
  await expect.poll(accent).toBe('#f0abfc');
  const downloading = page.waitForEvent('download');
  await darkSettings
    .getByRole('button', { name: '导出主题', exact: true })
    .click();
  const exported = await downloading;
  expect(await readFile((await exported.path())!, 'utf8')).toContain(
    '--accent: #f0abfc;',
  );
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord');
  await expect.poll(accent).toBe('#f0abfc');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await lightSettings.getByText('Nord Snow', { exact: true }).click();
  await expect.poll(accent).toBe('#f0abfc');
  await lightSettings.getByText('自定义 CSS', { exact: true }).click();
  await lightSettings
    .getByLabel('浅色 CSS', { exact: true })
    .fill(':root { --accent: #be185d; }');
  await lightSettings
    .getByRole('button', { name: '应用 CSS', exact: true })
    .click();
  await expect.poll(accent).toBe('#f0abfc');
  await settings.getByText('浅色', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'snow');
  await expect.poll(accent).toBe('#be185d');
  await lightSettings.getByText('Catppuccin Latte', { exact: true }).click();
  await expect.poll(accent).toBe('#8839ef');
  await lightSettings.getByText('自定义 CSS', { exact: true }).click();
  await expect.poll(accent).toBe('#be185d');
  await settings.getByText('暗色', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'nord');
  await expect.poll(accent).toBe('#f0abfc');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload();
  await expect.poll(accent).toBe('#f0abfc');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(
    lightSettings.getByLabel('浅色 CSS', { exact: true }),
  ).toHaveValue(':root { --accent: #be185d; }');
  await darkSettings
    .getByRole('button', { name: '清空 CSS', exact: true })
    .click();
  await expect.poll(accent).toBe('#88c0d0');
  await darkSettings.getByText('Nord', { exact: true }).click();
  await settings.getByText('浅色', { exact: true }).click();
  await expect.poll(accent).toBe('#be185d');
  await lightSettings.getByText('纸白', { exact: true }).click();
  await expect.poll(accent).toBe('#0969da');
  await settings.getByText('暗色', { exact: true }).click();
  for (const [id, name] of [
    ['nord', 'Nord'],
    ['mocha', 'Catppuccin Mocha'],
    ['graphite', '石墨灰'],
  ]) {
    await darkSettings.getByText(name, { exact: true }).click();
    await settings
      .getByRole('button', { name: '关闭设置', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', id);
    await expect(page.locator('.textLayer').first()).toContainText('Research fixture');
    await page.screenshot({
      path: `.runtime/dev/screenshots/theme-${id}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '设置', exact: true }).click();
  }
  await page.screenshot({
    path: '.runtime/dev/screenshots/appearance-settings.png',
    fullPage: true,
    animations: 'disabled',
  });
  await settings.getByText('跟随系统', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'paper');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute(
    'data-palette',
    'graphite',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await settings.getByText('暗色', { exact: true }).click();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('.reader-panel')).toBeVisible();
  await page.screenshot({
    path: '.runtime/dev/screenshots/workbench-tablet.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (let index = 0; index < 7; index++)
    await request.post('/api/workspaces', {
      data: { id: crypto.randomUUID(), name: `扩展研究 ${index}` },
    });
  await page.reload();
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  expect(
    await page
      .locator('.workspace-menu-list')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await page.getByRole('menuitem', { name: '新建工作区', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('第二工作区');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '第二工作区', exact: true }),
  ).toBeVisible();
  const secondUrl = page.url();
  await page.goto('/');
  await expect(page).toHaveURL(secondUrl);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '文件配置中的研究', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}`));
  expect(errors).toEqual([]);
});
