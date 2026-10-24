import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

test.use({
  viewport: { width: 1024, height: 768 }, hasTouch: true,
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

declare global {
  interface Window {
    __voiceTestTracks: MediaStreamTrack[];
    __voiceTestTranscript: string | null;
    __voiceTestEmit: (event: object) => void;
  }
}

test('voice connections are shared by the composer and global settings', async ({
  page,
  request,
}) => {
  const workspace = await (
    await request.post('/api/workspaces', {
      data: { id: randomUUID(), name: '语音工作区' },
    })
  ).json();
  const conversation = await (
    await request.post(`/api/workspaces/${workspace.id}/conversations`, {
      data: { id: randomUUID(), name: '语音对话' },
    })
  ).json();
  await page.goto(`/workspaces/${workspace.id}?conversation=${conversation.id}`);
  await page.getByLabel('对话消息').waitFor();

  await page.getByRole('button', { name: '开始语音输入' }).tap();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByText('尚未连接 ChatGPT 授权')).toBeVisible();

  const initialBox = await settings.boundingBox();
  await settings.getByRole('button', { name: '外观', exact: true }).tap();
  await expect(
    settings.getByRole('group', { name: '暗色模式', exact: true }),
  ).toBeVisible();
  const appearanceBox = await settings.boundingBox();
  expect(appearanceBox?.width).toBe(initialBox?.width);
  expect(appearanceBox?.height).toBe(initialBox?.height);
  await settings.getByRole('button', { name: '模型', exact: true }).tap();
  await expect(settings.getByText('尚未连接 ChatGPT 授权')).toBeVisible();

  await settings.getByRole('button', { name: '添加语音服务' }).tap();
  await settings.getByLabel('名称').fill('本地转写');
  await settings.getByLabel('连接协议').selectOption('file');
  await settings.getByLabel('接口地址').fill('http://127.0.0.1:9/v1');
  await settings.getByLabel('模型 ID').fill('whisper-1');
  await settings.getByLabel('API 密钥').fill('sk-e2e-secret');
  await settings.getByRole('button', { name: '添加连接' }).tap();
  const card = settings.locator('.speech-card').filter({ hasText: '本地转写' });
  await expect(card).toBeVisible();
  await expect(card.locator('input[type=radio]')).toBeChecked();
  const configuredBox = await settings.boundingBox();
  expect(configuredBox?.width).toBe(initialBox?.width);
  expect(configuredBox?.height).toBe(initialBox?.height);
  await settings.getByRole('button', { name: '关闭设置' }).tap();
  await expect(
    page.getByRole('button', { name: '开始语音输入' }),
  ).toHaveAttribute('title', '开始语音输入 · 本地转写');

  const speech = await (await request.get('/api/speech')).json();
  expect(JSON.stringify(speech)).not.toContain('sk-e2e-secret');
  expect(speech.connections).toHaveLength(1);

  await page.reload();
  await page.getByLabel('对话消息').waitFor();
  await expect(
    page.getByRole('button', { name: '开始语音输入' }),
  ).toHaveAttribute('title', '开始语音输入 · 本地转写');

  await page.getByRole('button', { name: '模型设置' }).tap();
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole('button', { name: '模型', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    settings.locator('.speech-card').filter({ hasText: '本地转写' }),
  ).toBeVisible();
  await settings.getByRole('button', { name: '关闭设置' }).tap();

  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await settings.getByRole('button', { name: '模型', exact: true }).tap();
  await expect(
    settings.locator('.speech-card').filter({ hasText: '本地转写' }),
  ).toBeVisible();
  await settings.getByRole('radio', { name: /ChatGPT 授权/ }).tap({
    force: true,
  });
  await expect
    .poll(async () => (await (await request.get('/api/speech')).json()).activeId)
    .toBe('chatgpt');
  await settings.getByRole('button', { name: '关闭设置' }).tap();
  await expect(
    page.getByRole('button', { name: '开始语音输入' }),
  ).toHaveAttribute('title', '开始语音输入（尚未配置）');

  await page.getByRole('button', { name: '模型设置' }).tap();
  await expect(settings).toBeVisible();
  await expect(
    settings.locator('.speech-card').filter({ hasText: '本地转写' }),
  ).toBeVisible();
  await settings.getByRole('button', { name: '删除 本地转写' }).tap();
  await settings.getByRole('button', { name: '确认删除' }).tap();
  await expect(
    settings.locator('.speech-card').filter({ hasText: '本地转写' }),
  ).toHaveCount(0);
  await settings.getByRole('button', { name: '关闭设置' }).tap();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/speech')).json()).connections.length,
    )
    .toBe(0);
});

test('touch recording inserts editable text at the caret, cancels cleanly and recovers from transcription failure', async ({ page, request }) => {
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  await request.post('/api/workspaces', { data: { id: workspaceId, name: '录音检查' } });
  await request.post(`/api/workspaces/${workspaceId}/conversations`, { data: { id: conversationId, name: '提问' } });
  await request.post('/api/speech/connections', { data: {
    name: '实时语音', protocol: 'realtime', baseUrl: 'http://127.0.0.1:9/v1', model: 'test',
  } });
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    window.__voiceTestTracks = tracks;
    window.__voiceTestTranscript = null;
    const getMicrophone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await getMicrophone(options);
      tracks.push(...stream.getTracks());
      return stream;
    };
    class Channel extends EventTarget {
      readyState = 'open';
      onmessage: ((event: { data: string }) => void) | null = null;
      send(message: string) {
        if (JSON.parse(message).type === 'input_audio_buffer.commit')
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
            ...(window.__voiceTestTranscript === null ? {
              type: 'conversation.item.input_audio_transcription.failed',
              error: { message: '无法识别这段音频' },
            } : {
              type: 'conversation.item.input_audio_transcription.completed',
              transcript: window.__voiceTestTranscript,
            }),
            item_id: 'recording-item',
          }) }));
      }
      close() { this.readyState = 'closed'; }
    }
    Object.defineProperty(window, 'RTCPeerConnection', { value: class {
      connectionState = 'connected';
      createDataChannel() {
        const channel = new Channel();
        window.__voiceTestEmit = event => channel.onmessage?.({ data: JSON.stringify(event) });
        return channel;
      }
      addTrack() {}
      async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() { this.connectionState = 'closed'; }
    } });
  });
  await page.route('**/api/speech/realtime', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ sdp: 'test-answer' }),
  }));
  await page.goto(`/workspaces/${workspaceId}?conversation=${conversationId}`);
  const start = page.getByRole('button', { name: '开始语音输入' });
  await expect(start).toHaveAttribute('title', /实时语音/);
  const draft = page.getByLabel('对话消息');
  await draft.fill('保留原有草稿');
  await start.tap();
  const stop = page.getByRole('button', { name: /正在录音.*点击结束/ });
  const cancel = page.getByRole('button', { name: '取消语音输入' });
  await expect(stop).toBeVisible();
  const cancelBox = (await cancel.boundingBox())!;
  const stopBox = (await stop.boundingBox())!;
  expect(cancelBox.width).toBeGreaterThanOrEqual(44);
  expect(cancelBox.height).toBeGreaterThanOrEqual(44);
  expect(cancelBox.x).toBeGreaterThanOrEqual(stopBox.x + stopBox.width);
  await cancel.tap();
  await expect(start).toBeVisible();
  await expect(draft).toHaveValue('保留原有草稿');
  expect(await page.evaluate(() => window.__voiceTestTracks.every(track => track.readyState === 'ended'))).toBe(true);

  await start.tap();
  await expect(stop).toBeVisible();
  await stop.tap();
  await expect(page.getByRole('alert').filter({ hasText: '无法识别这段音频' })).toBeVisible({ timeout: 2000 });
  await expect(start).toBeVisible();
  await expect(draft).toHaveValue('保留原有草稿');
  expect(await page.evaluate(() => window.__voiceTestTracks.every(track => track.readyState === 'ended'))).toBe(true);
  await start.tap();
  await expect(cancel).toBeVisible();
  await cancel.tap();

  await draft.fill('前文后文');
  await draft.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(2, 2); });
  await page.evaluate(() => { window.__voiceTestTranscript = '你好'; });
  await start.tap();
  await expect(stop).toBeVisible();
  await page.evaluate(() => window.__voiceTestEmit({
    type: 'conversation.item.input_audio_transcription.delta', item_id: 'recording-item', delta: '你',
  }));
  await stop.tap();
  await expect(start).toBeVisible();
  await expect(draft).toHaveValue('前文你好后文');

  await start.tap();
  await expect(stop).toBeVisible();
  await page.evaluate(() => window.__voiceTestEmit({
    type: 'conversation.item.input_audio_transcription.completed', item_id: 'recording-item', transcript: '语音内容',
  }));
  await expect(draft).toHaveValue(/语音内容/);
  await draft.fill(`手动修改${await draft.inputValue()}`);
  await cancel.tap();
  await expect(draft).toHaveValue('手动修改前文你好后文');
});
