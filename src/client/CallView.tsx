import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
  Maximize2,
  Send,
} from 'lucide-react';
import { Mascot } from './Mascot';
import type { Dot } from '../shared/types';
import type { useVoice } from './useVoice';

export function CallView({
  dot,
  voice,
}: {
  dot: Dot;
  voice: ReturnType<typeof useVoice>;
}) {
  const [minimized, setMinimized] = useState(false);
  const [inputText, setInputText] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (voice.status !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [voice.status]);
  if (voice.status === 'idle') return null;
  const seconds = voice.startedAt
    ? Math.max(0, Math.floor((now - voice.startedAt) / 1000))
    : 0;
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const label =
    voice.status === 'connecting'
      ? 'Connecting…'
      : voice.status === 'ending'
        ? 'Saving call…'
        : voice.muted
          ? 'Microphone muted'
          : voice.phase === 'speaking'
            ? `${dot.name} is speaking`
            : voice.phase === 'thinking'
              ? 'Working on it…'
              : 'Listening';
  return (
    <section
      className={`call-view ${minimized ? 'minimized' : ''}`}
      aria-label={`Voice call with ${dot.name}`}
    >
      <div className="call-heading">
        <span>
          <span className="call-live-dot" /> Voice call
        </span>
        <button
          className="call-minimize"
          aria-label={minimized ? 'Expand call view' : 'Minimize call view'}
          onClick={() => setMinimized(!minimized)}
        >
          {minimized ? <Maximize2 size={18} /> : <ChevronDown size={20} />}
        </button>
      </div>
      <div className={`call-persona ${voice.phase}`}>
        <Mascot identity={dot.id} name={dot.name} />
        <h2>{dot.name}</h2>
        <span className="call-timer" aria-label="Call duration">
          {duration}
        </span>
        <p role="status">{label}</p>
      </div>
      {!minimized && (
        <div className="call-caption" aria-live="polite">
          {voice.userCaption && (
            <p className="call-user-caption">
              <small>You</small>
              {voice.userCaption}
            </p>
          )}
          <p>
            <small>{dot.name}</small>
            {voice.caption || 'Speak naturally. Your Woofy is here with you.'}
          </p>
        </div>
      )}
      {!minimized && voice.status === 'active' && (
        <div
          className="call-quick-actions"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            justifyContent: 'center',
            margin: '12px 0 6px',
            maxWidth: '440px',
          }}
        >
          {[
            {
              label: '✉️ Send Mail',
              prompt: 'Please open mail compose window to send an email.',
            },
            {
              label: '📝 Write in Notepad',
              prompt: 'Please open Notepad and write a note for Nitin.',
            },
            {
              label: '▶️ YouTube',
              prompt: 'Please search YouTube for top music hits.',
            },
            {
              label: '🌐 Open Chrome',
              prompt: 'Please open Google Chrome browser.',
            },
            {
              label: '💻 VS Code',
              prompt: 'Please open Visual Studio Code.',
            },
            {
              label: '📸 Screenshot',
              prompt: 'Please take a screenshot of my screen.',
            },
          ].map((act) => (
            <button
              key={act.label}
              type="button"
              style={{
                background: 'rgba(255, 255, 255, 0.15)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                color: '#fff',
                borderRadius: '16px',
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
              }}
              onClick={() => voice.sendText(act.prompt)}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
      {!minimized && voice.status === 'active' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (inputText.trim()) {
              voice.sendText(inputText.trim());
              setInputText('');
            }
          }}
          style={{
            display: 'flex',
            gap: '8px',
            width: '100%',
            maxWidth: '380px',
            margin: '6px 0 14px',
          }}
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type or speak to Woofy…"
            style={{
              flex: 1,
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#fff',
              borderRadius: '20px',
              padding: '8px 16px',
              fontSize: '13px',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            style={{
              background: '#abf1d5',
              border: 'none',
              color: '#133d37',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: inputText.trim() ? 'pointer' : 'default',
              opacity: inputText.trim() ? 1 : 0.5,
            }}
          >
            <Send size={16} />
          </button>
        </form>
      )}
      {voice.error && (
        <p className="call-warning" role="alert">
          {voice.error}
        </p>
      )}
      <div className="call-controls">
        <button
          aria-label={
            voice.speakerMuted ? 'Enable call audio' : 'Mute call audio'
          }
          aria-pressed={voice.speakerMuted}
          onClick={voice.toggleSpeaker}
          disabled={voice.status !== 'active'}
        >
          <span>{voice.speakerMuted ? <VolumeX /> : <Volume2 />}</span>
          <small>Speaker</small>
        </button>
        <button
          className="call-end"
          aria-label="End voice call"
          onClick={() => void voice.end()}
          disabled={voice.status === 'ending'}
        >
          <span>
            <PhoneOff />
          </span>
          <small>End</small>
        </button>
        <button
          aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={voice.muted}
          onClick={voice.toggleMute}
          disabled={voice.status !== 'active'}
        >
          <span>{voice.muted ? <MicOff /> : <Mic />}</span>
          <small>{voice.muted ? 'Unmute' : 'Mute'}</small>
        </button>
      </div>
      {!minimized && (
        <p className="call-footer">Text and voice share this conversation</p>
      )}
    </section>
  );
}
