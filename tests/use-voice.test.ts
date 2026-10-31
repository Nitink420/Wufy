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

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      }),
    },
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

it('activates call and updates startedAt', () => {
  expect(voice.status).toBe('active');
  expect(voice.startedAt).toBeDefined();
  expect(voice.phase).toBe('listening');
});

it('handles mute and speaker mute toggles', () => {
  expect(voice.muted).toBe(false);
  act(() => {
    voice.toggleMute();
  });
  expect(voice.muted).toBe(true);
  expect(track.enabled).toBe(false);

  expect(voice.speakerMuted).toBe(false);
  act(() => {
    voice.toggleSpeaker();
  });
  expect(voice.speakerMuted).toBe(true);
});

it('receives model transcription and updates captions', async () => {
  await act(async () => {
    fakeSession.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: 'Hello, how can I help you today?' },
      },
    });
  });
  expect(voice.caption).toBe('Hello, how can I help you today?');
  expect(voice.phase).toBe('speaking');
});

it('handles user interruption', async () => {
  await act(async () => {
    fakeSession.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: 'Long talking text...' },
      },
    });
  });
  expect(voice.phase).toBe('speaking');

  await act(async () => {
    fakeSession.callbacks.onmessage({
      serverContent: {
        interrupted: true,
      },
    });
  });
  expect(voice.phase).toBe('listening');
});

it('handles ask_compute tool calls and responds to Gemini Live', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/voice/calls/call/compute') {
      return { text: 'Compute answer from specialist' };
    }
    return { endedAt: null };
  });

  await act(async () => {
    fakeSession.callbacks.onmessage({
      toolCall: {
        functionCalls: [
          {
            name: 'ask_compute',
            id: 'call-123',
            args: { request: 'Research topic' },
          },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(fakeSession.sendToolResponse).toHaveBeenCalledWith(
    expect.objectContaining({
      functionResponses: [
        expect.objectContaining({
          name: 'ask_compute',
          id: 'call-123',
          response: { output: 'Compute answer from specialist' },
        }),
      ],
    }),
  );
});

it('ends call on manual end and calls /end', async () => {
  await act(async () => {
    await voice.end();
  });
  expect(ends()).toHaveLength(1);
  expect(voice.status).toBe('idle');
});

it('ends call when session closes', async () => {
  await act(async () => {
    fakeSession.callbacks.onclose();
  });
  expect(ends()).toHaveLength(1);
  expect(voice.status).toBe('idle');
});
