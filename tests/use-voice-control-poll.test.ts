import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVoice } from '../src/client/useVoice';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api, authHeaders: () => ({}) }));

let fakeSession: any;
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = {
      connect: vi.fn(async (params: any) => {
        fakeSession = {
          callbacks: params.callbacks,
          sendRealtimeInput: vi.fn(),
          sendToolResponse: vi.fn(),
          close: vi.fn(() => params.callbacks?.onclose?.()),
        };
        setTimeout(() => params.callbacks?.onopen?.(), 0);
        return fakeSession;
      }),
    };
  },
}));

class FakeAudioContext {
  state = 'running';
  sampleRate = 16000;
  currentTime = 0;
  destination = {};
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() };
  }
  createBuffer() {
    return { getChannelData: () => new Float32Array(100), duration: 0.1 };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }
  async close() {
    this.state = 'closed';
  }
}

let voice: ReturnType<typeof useVoice>;
let root: ReactTestRenderer;
const track = { stop: vi.fn(), enabled: true };

function Hook() {
  voice = useVoice('thread', () => {});
  return null;
}

function failPolls(times: number) {
  let seen = 0;
  api.mockImplementation(async (path: string) => {
    if (path === '/voice/calls')
      return { id: 'call', token: 'auth_tokens/test', model: 'gemini-3.8-live' };
    if (path === '/voice/calls/call' && seen < times) {
      seen += 1;
      throw new Error('network flap');
    }
    return { endedAt: null };
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));

  api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === '/voice/calls'
        ? { id: 'call', token: 'auth_tokens/test', model: 'gemini-3.8-live' }
        : { endedAt: null },
    );

  await act(async () => {
    root = create(createElement(Hook));
  });

  await act(async () => {
    await voice.start();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(voice.status).toBe('active');
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ends = () => api.mock.calls.filter(([path]) => path.endsWith('/end'));

it('keeps the call alive after a single failed control poll', async () => {
  failPolls(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('active');
  expect(voice.error).toBe('');
});

it('keeps the call alive when a later poll succeeds before the failure limit', async () => {
  failPolls(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('active');
  expect(voice.error).toBe('');
});

it('ends the call when control polls reach the consecutive failure limit', async () => {
  failPolls(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(1);
  expect(voice.status).toBe('idle');
  expect(voice.error).toBe('Call control connection was lost.');
});
