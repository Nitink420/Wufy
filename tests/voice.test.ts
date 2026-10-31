import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService } from '../src/server/voice.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const createTokenMock = vi.fn(async () => ({
  name: 'auth_tokens/test-token-123',
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    authTokens = {
      create: createTokenMock,
    };
  },
  Modality: { AUDIO: 'AUDIO' },
  Type: { OBJECT: 'OBJECT', STRING: 'STRING' },
}));

const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.useRealTimers();
  createTokenMock.mockReset();
  createTokenMock.mockResolvedValue({ name: 'auth_tokens/test-token-123' });
});

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceKey: 'test-secret',
    voiceModel: 'gemini-3.8-live',
    voiceName: 'Aoede',
    runtimeUrl: '',
    slackUsers: [],
  };
  const turn = vi.fn(
    async (_thread: string, _prompt: string, _signal: AbortSignal) =>
      'Current answer',
  );
  const history = vi.fn(async () => 'user: Earlier topic');
  const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history,
      requireReady() {},
      setup: () => ({
        voice: true,
        intelligence: true,
        model: true,
        browser: false,
        composio: false,
        slack: 'not_configured',
        missing: [],
      }),
    },
    transport,
  );
  return { voice, transport, workspace, store, turn, history };
}

it('binds voice history and compute to the existing thread, creates Gemini ephemeral token and saves receipts', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  expect(f.history).toHaveBeenCalledWith('thread');
  expect(call.token).toBe('auth_tokens/test-token-123');
  expect(call.model).toBe('gemini-3.8-live');
  expect(createTokenMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        liveConnectConstraints: expect.objectContaining({
          model: 'gemini-3.8-live',
        }),
      }),
    }),
  );

  f.voice.activate(call.id);
  await Promise.all([
    f.voice.compute(call.id, 'tool-1', 'Research'),
    f.voice.compute(call.id, 'tool-1', 'Research'),
  ]);
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn.mock.calls[0]?.[0]).toBe('thread');

  await f.voice.end(call.id, 'Confirmed discussion');
  expect(f.workspace.call(call.id).status).toBe('ended');
  expect(f.turn).toHaveBeenLastCalledWith(
    'thread',
    expect.stringContaining('Record a short call receipt'),
    expect.any(AbortSignal),
    { opendotsSource: 'voice_receipt' },
  );
  await expect(f.voice.compute(call.id, 'late', 'Research')).rejects.toThrow(
    'ended',
  );
});

it('rejects unowned threads before provider contact and expires unactivated peers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    f.voice.begin('foreign', new AbortController().signal),
  ).rejects.toThrow();
  expect(createTokenMock).not.toHaveBeenCalled();

  const call = await f.voice.begin('thread', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(f.workspace.call(call.id).status).toBe('failed');
});

it('aborts a pending history lookup without starting a provider session', async () => {
  const f = fixture();
  f.history.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = f.voice.begin('thread', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(createTokenMock).not.toHaveBeenCalled();
});

it('fails visibly for provider token creation errors', async () => {
  const f = fixture();
  createTokenMock.mockRejectedValueOnce(new Error('Rate limit exceeded 429'));
  await expect(
    f.voice.begin('thread', new AbortController().signal),
  ).rejects.toThrow('429');
});

it('fails if token name is missing from Gemini response', async () => {
  const f = fixture();
  createTokenMock.mockResolvedValueOnce({ name: undefined as unknown as string });
  await expect(
    f.voice.begin('thread', new AbortController().signal),
  ).rejects.toThrow('token creation failed');
});

it('saves a late transcript after expiry without changing the ended status or duration', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30_001);
  const expired = f.workspace.call(call.id);
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  expect(f.workspace.call(call.id)).toMatchObject({
    status: 'failed',
    endedAt: expired.endedAt,
    transcript: 'Buffered speech at disconnect',
  });
  expect(f.turn).toHaveBeenCalledTimes(1);
});

it('defers paused transcript synchronization and resumes it once without a duplicate turn', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  f.store.updateSettings({ paused: true });
  f.voice.abortAll();
  await f.voice.end(call.id, 'Speech saved while paused');
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.workspace.call(call.id).transcript).toBe(
    'Speech saved while paused',
  );
  expect(f.workspace.call(call.id).error).toContain(
    'pending Intelligence sync',
  );
  f.store.updateSettings({ paused: false });
  await f.voice.resumePending();
  await f.voice.resumePending();
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.workspace.call(call.id).status).toBe('failed');
});

it('allows a rejected compute call to be retried with the same tool ID', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  f.voice.activate(call.id);
  f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
  await expect(f.voice.compute(call.id, 'retry', 'Research')).rejects.toThrow(
    'Provider unavailable',
  );
  await expect(f.voice.compute(call.id, 'retry', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(2);
  await f.voice.end(call.id, '');
});

it('counts failed compute attempts toward the six-turn limit', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      f.voice.compute(call.id, `failed-${i}`, 'Research'),
    ).rejects.toThrow('Provider unavailable');
  }
  await expect(f.voice.compute(call.id, 'success', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});

it('counts a retry of the same tool ID as another attempt', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
      'Provider unavailable',
    );
  }
  await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});

it('keeps successful compute turns cached and enforces the six-turn cap', async () => {
  const f = fixture();
  const call = await f.voice.begin('thread', new AbortController().signal);
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    await expect(f.voice.compute(call.id, String(i), 'Research')).resolves.toBe(
      'Current answer',
    );
  }
  await expect(f.voice.compute(call.id, '0', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await expect(f.voice.compute(call.id, 'extra', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  await f.voice.end(call.id, '');
});
