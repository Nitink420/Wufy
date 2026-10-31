import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GoogleGenAI,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { api, authHeaders } from './api';

// Fail remote control connection only after consecutive poll failures
const CONTROL_POLL_FAILURE_LIMIT = 3;

function getAudioContextClass(): typeof AudioContext {
  const AudioCtx =
    (typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      : undefined) || globalThis.AudioContext;
  if (!AudioCtx) {
    throw new Error('Web Audio API is not supported in this environment.');
  }
  return AudioCtx;
}

/** Convert Float32Array audio data [-1.0, 1.0] to 16-bit linear PCM Int16Array */
function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

/** Simple nearest-neighbor resampler for audio rate conversion */
function resample(
  source: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) return source;
  const ratio = sourceRate / targetRate;
  const newLength = Math.round(source.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const idx = Math.floor(i * ratio);
    result[i] = source[idx];
  }
  return result;
}

/** Encode an ArrayBuffer / Uint8Array to base64 string */
function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunkSize, len)) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Decode Base64-encoded 16-bit linear PCM audio into Float32Array [-1.0, 1.0] */
function base64ToFloat32Array(base64: string): Float32Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const dataView = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = dataView.getInt16(i * 2, true) / 32768.0; // little-endian
  }
  return float32;
}

interface VoiceSession {
  id?: string;
  stream?: MediaStream;
  inputCtx?: AudioContext;
  processor?: ScriptProcessorNode;
  outputCtx?: AudioContext;
  gainNode?: GainNode;
  activeSources: AudioBufferSourceNode[];
  nextPlayTime: number;
  liveSession?: Session;
  transcript: string[];
  currentAssistantText: string;
  timer?: ReturnType<typeof setTimeout>;
  controlPollFailures: number;
  cancelled: boolean;
}

export function useVoice(
  threadId: string,
  onSaved: () => void,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const generation = useRef(0);
  const connecting = useRef(false);
  const ending = useRef(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>(
    'listening',
  );
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');

  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const speakerMutedRef = useRef(false);
  speakerMutedRef.current = speakerMuted;

  const session = useRef<VoiceSession | undefined>(undefined);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;

  const stopAllAudio = useCallback((voiceSession: VoiceSession) => {
    for (const s of voiceSession.activeSources) {
      try {
        s.stop();
        s.disconnect();
      } catch {}
    }
    voiceSession.activeSources = [];
    if (voiceSession.outputCtx) {
      voiceSession.nextPlayTime = voiceSession.outputCtx.currentTime;
    }
  }, []);

  const closeMedia = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;

    if (current.stream) {
      current.stream.getTracks().forEach((track) => track.stop());
    }
    if (current.processor) {
      try {
        current.processor.disconnect();
      } catch {}
    }
    if (current.inputCtx && current.inputCtx.state !== 'closed') {
      try {
        void current.inputCtx.close();
      } catch {}
    }
    stopAllAudio(current);
    if (current.outputCtx && current.outputCtx.state !== 'closed') {
      try {
        void current.outputCtx.close();
      } catch {}
    }
    if (current.liveSession) {
      try {
        current.liveSession.close();
      } catch {}
    }
    clearTimeout(current.timer);
  }, [stopAllAudio]);

  const end = useCallback(async () => {
    if (ending.current) return;
    generation.current++;
    connecting.current = false;
    ending.current = true;
    setStatus('ending');

    const current = session.current;
    if (!current) {
      ending.current = false;
      setStatus('idle');
      return;
    }

    current.cancelled = true;
    if (current.stream) {
      current.stream.getTracks().forEach((track) => {
        track.enabled = false;
        track.stop();
      });
    }
    stopAllAudio(current);

    const callId = current.id;
    try {
      if (callId) {
        await api(`/voice/calls/${callId}/end`, 'POST', {
          transcript: current.transcript.join('\n').slice(0, 20000),
          anchorMessageId: anchor.current,
        });
      }
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Call ended, but its receipt could not be saved.',
      );
    } finally {
      closeMedia();
      session.current = undefined;
      ending.current = false;
      setStatus('idle');
    }
  }, [closeMedia, onSaved, stopAllAudio]);

  // Clean up on component unmount
  useEffect(
    () => () => {
      generation.current++;
      const current = session.current;
      closeMedia();
      if (current?.id && !ending.current) {
        void fetch(`/api/voice/calls/${current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            transcript: current.transcript.join('\n').slice(0, 20000),
            anchorMessageId: anchor.current,
          }),
          keepalive: true,
        }).catch(() => {});
      }
    },
    [closeMedia],
  );

  // Poll for remote call termination
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;
    const timer = setInterval(() => {
      const current = session.current;
      const id = current?.id;
      if (id) {
        void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
          .then((call) => {
            if (session.current !== current) return;
            if (call.endedAt) {
              void end();
              return;
            }
            current.controlPollFailures = 0;
          })
          .catch(() => {
            if (session.current !== current) return;
            current.controlPollFailures += 1;
            if (current.controlPollFailures < CONTROL_POLL_FAILURE_LIMIT)
              return;
            setError('Call control connection was lost.');
            void end();
          });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [status, end]);

  const start = async () => {
    if (session.current || connecting.current || ending.current) return;
    connecting.current = true;
    const attempt = ++generation.current;
    setStatus('connecting');
    setError('');
    setMuted(false);
    mutedRef.current = false;
    setSpeakerMuted(false);
    speakerMutedRef.current = false;
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');

    // CRITICAL: Initialize AudioContexts SYNCHRONOUSLY within the user click gesture!
    // If initialized after asynchronous await calls, browser autoplay policy suspends them,
    // causing microphone audio capture to be completely silenced and speaker playback to fail!
    const AudioCtx = getAudioContextClass();
    const inputCtx = new AudioCtx();
    const outputCtx = new AudioCtx();
    try {
      void inputCtx.resume();
      void outputCtx.resume();
    } catch {}

    let stream: MediaStream | undefined;
    try {
      // 1. Microphone access
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        void inputCtx.close();
        void outputCtx.close();
        return;
      }

      // 2. Request new voice call from server to obtain Gemini Live ephemeral token
      const callData = await api<{
        id: string;
        token: string;
        model: string;
      }>('/voice/calls', 'POST', { threadId });

      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        void inputCtx.close();
        void outputCtx.close();
        void api(`/voice/calls/${callData.id}/end`, 'POST', { transcript: '' });
        return;
      }

      // 3. Audio contexts routing
      if (inputCtx.state === 'suspended') {
        try {
          await inputCtx.resume();
        } catch {}
      }
      if (outputCtx.state === 'suspended') {
        try {
          await outputCtx.resume();
        } catch {}
      }

      const gainNode = outputCtx.createGain();
      gainNode.gain.value = speakerMutedRef.current ? 0 : 1;
      gainNode.connect(outputCtx.destination);

      const current: VoiceSession = {
        id: callData.id,
        stream,
        inputCtx,
        outputCtx,
        gainNode,
        activeSources: [],
        nextPlayTime: outputCtx.currentTime,
        transcript: [],
        currentAssistantText: '',
        controlPollFailures: 0,
        cancelled: false,
      };
      session.current = current;

      // 5. Connect to Google Gemini Live API using ephemeral token
      const ai = new GoogleGenAI({
        apiKey: callData.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });

      const handleLiveMessage = (e: LiveServerMessage) => {
        if (current.cancelled) return;

        // User spoke: interrupt assistant speech
        if (e.serverContent?.interrupted) {
          stopAllAudio(current);
          setPhase('listening');
        }

        // Realtime interim user transcription
        if (e.serverContent?.interimInputTranscription?.text) {
          setUserCaption(e.serverContent.interimInputTranscription.text);
          setPhase('listening');
        }

        // Final user speech transcription
        if (e.serverContent?.inputTranscription?.text) {
          const userText = e.serverContent.inputTranscription.text;
          setUserCaption(userText);
          current.transcript.push(`You: ${userText}`);
        }

        // Model output transcription delta
        if (e.serverContent?.outputTranscription?.text) {
          const text = e.serverContent.outputTranscription.text;
          current.currentAssistantText += text;
          setCaption(current.currentAssistantText);
          setPhase('speaking');
        }

        // Audio parts generated by model
        if (e.serverContent?.modelTurn?.parts) {
          for (const part of e.serverContent.modelTurn.parts) {
            if (part.text && !e.serverContent.outputTranscription?.text) {
              current.currentAssistantText += part.text;
              setCaption(current.currentAssistantText);
            }
            if (
              part.inlineData?.data &&
              part.inlineData.mimeType?.startsWith('audio/pcm')
            ) {
              setPhase('speaking');
              const float32 = base64ToFloat32Array(part.inlineData.data);
              let sampleRate = 24000;
              const rateMatch = part.inlineData.mimeType.match(/rate=(\d+)/);
              if (rateMatch) {
                sampleRate = parseInt(rateMatch[1], 10);
              }

              if (
                current.outputCtx &&
                current.gainNode &&
                float32.length > 0
              ) {
                if (current.outputCtx.state === 'suspended') {
                  void current.outputCtx.resume();
                }

                const audioBuffer = current.outputCtx.createBuffer(
                  1,
                  float32.length,
                  sampleRate,
                );
                audioBuffer.getChannelData(0).set(float32);

                const source = current.outputCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(current.gainNode);

                const now = current.outputCtx.currentTime;
                const startTime = Math.max(now, current.nextPlayTime);
                source.start(startTime);
                current.nextPlayTime = startTime + audioBuffer.duration;

                current.activeSources.push(source);
                source.onended = () => {
                  const idx = current.activeSources.indexOf(source);
                  if (idx !== -1) current.activeSources.splice(idx, 1);
                };
              }
            }
          }
        }

        // Model turn complete
        if (e.serverContent?.turnComplete) {
          if (current.currentAssistantText.trim()) {
            current.transcript.push(
              `Woofy: ${current.currentAssistantText.trim()}`,
            );
            current.currentAssistantText = '';
          }
          setPhase('listening');
        }

        // Tool calls (ask_compute, open_chrome, open_notepad, open_vscode, take_screenshot, etc.)
        if (e.toolCall?.functionCalls?.length) {
          setPhase('thinking');
          for (const call of e.toolCall.functionCalls) {
            if (call.name && call.id && current.id) {
              const callId = current.id;
              const toolCallId = call.id;
              const toolName = call.name;
              const args = (call.args || {}) as Record<string, unknown>;

              void (async () => {
                let outputText: string;
                try {
                  if (toolName === 'ask_compute') {
                    const requestText = (args.request as string) || '';
                    const res = await api<{ text?: string; output?: string }>(
                      `/voice/calls/${callId}/compute`,
                      'POST',
                      {
                        toolCallId,
                        request: requestText,
                        transcript: current.transcript
                          .join('\n')
                          .slice(-12000),
                      },
                    );
                    outputText = res.output ?? res.text ?? 'Done.';
                  } else {
                    const res = await api<{ text?: string; output?: string }>(
                      `/voice/calls/${callId}/tool`,
                      'POST',
                      {
                        toolCallId,
                        name: toolName,
                        args,
                      },
                    );
                    outputText = res.output ?? res.text ?? 'Done.';
                  }
                } catch (err) {
                  outputText = `Tool execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
                }

                if (current.liveSession && !current.cancelled) {
                  try {
                    current.liveSession.sendToolResponse({
                      functionResponses: [
                        {
                          name: toolName,
                          id: toolCallId,
                          response: { output: outputText },
                        },
                      ],
                    });
                  } catch (sendErr) {
                    console.error(
                      'Failed to send tool response to Gemini Live:',
                      sendErr,
                    );
                  }
                }
              })();
            }
          }
        }
      };

      const liveSession = await ai.live.connect({
        model: callData.model,
        callbacks: {
          onopen: () => {
            if (current.cancelled) return;
            setStatus('active');
            setStartedAt((val) => val ?? Date.now());
            if (current.id) {
              void api(`/voice/calls/${current.id}/active`, 'POST', {}).catch(
                (e) => {
                  if (!current.cancelled) setError(e.message);
                },
              );
            }
          },
          onmessage: (e: LiveServerMessage) => {
            handleLiveMessage(e);
          },
          onerror: (e) => {
            if (!current.cancelled) {
              console.error('Gemini Live session error:', e);
              setError(
                e instanceof Error
                  ? e.message
                  : 'The voice session encountered an error.',
              );
            }
          },
          onclose: (e: any) => {
            if (!current.cancelled && !ending.current) {
              console.warn('Gemini Live session closed:', e);
              if (e && e.code && e.code !== 1000) {
                setError(
                  `Voice connection closed: ${e.reason || `Code ${e.code}`}`,
                );
              }
              void end();
            }
          },
        },
      });

      current.liveSession = liveSession;

      // Immediately trigger Woofy to speak greeting to the user
      if (!current.cancelled) {
        try {
          console.log('[Woofy Live] Connection established, sending greeting prompt...');
          liveSession.sendClientContent({
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'Hello Woofy! Please warmly greet me out loud in one short sentence and let me know you are listening and ready to help.',
                  },
                ],
              },
            ],
            turnComplete: true,
          });
        } catch (greetErr) {
          console.error('[Woofy Live] Initial greeting trigger error:', greetErr);
        }
      }

      // 6. Connect microphone audio processor to stream PCM chunks
      const micSource = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (
          mutedRef.current ||
          !current.liveSession ||
          current.cancelled
        )
          return;

        const inputData = e.inputBuffer.getChannelData(0);
        const resampled = resample(inputData, inputCtx.sampleRate, 16000);
        const pcm16 = floatTo16BitPCM(resampled);
        const base64 = arrayBufferToBase64(pcm16.buffer);

        try {
          current.liveSession.sendRealtimeInput({
            media: {
              mimeType: 'audio/pcm;rate=16000',
              data: base64,
            },
          });
        } catch (err) {
          console.error('Failed to stream audio chunk:', err);
        }
      };

      micSource.connect(processor);
      const silentGain = inputCtx.createGain();
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(inputCtx.destination);
      current.processor = processor;

      // 7. Max call duration timer (15 minutes)
      current.timer = setTimeout(() => void end(), 15 * 60_000);
    } catch (e) {
      if (attempt !== generation.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      const current = session.current;
      const id = current?.id;
      if (id) {
        void api(`/voice/calls/${id}/end`, 'POST', {
          transcript: '',
          anchorMessageId: anchor.current,
        }).catch(() => {});
      }
      stream?.getTracks().forEach((track) => track.stop());
      closeMedia();
      session.current = undefined;
      setStatus('idle');
      setError(
        e instanceof Error ? e.message : 'Could not connect the call.',
      );
    } finally {
      if (attempt === generation.current) connecting.current = false;
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (session.current?.stream) {
      session.current.stream.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    speakerMutedRef.current = next;
    if (session.current?.gainNode) {
      session.current.gainNode.gain.value = next ? 0 : 1;
    }
  };

  const sendText = useCallback((text: string) => {
    const current = session.current;
    if (!current?.liveSession || current.cancelled || !text.trim()) return;
    const clean = text.trim();
    current.transcript.push(`You: ${clean}`);
    setUserCaption(clean);
    setPhase('thinking');
    try {
      current.liveSession.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [{ text: clean }],
          },
        ],
        turnComplete: true,
      });
    } catch (err) {
      console.error('Failed to send text to voice session:', err);
    }
  }, []);

  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    toggleMute,
    toggleSpeaker,
    sendText,
  };
}
