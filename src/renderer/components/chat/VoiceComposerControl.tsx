import React, { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Loader2, Mic, RadioTower, Volume2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';
import {
  getRealtimeVoiceLabel,
  REALTIME_VOICE_OPTIONS,
  type RealtimeVoiceOption,
} from '../../../shared/types/audio';
import { APP_VOICE_SESSION_ID } from '../../utils/voice-session-directory';
import type { RemoteVoiceDeploymentStatus } from '../../../shared/types/realtime-voice';

interface VoiceComposerControlProps {
  active: boolean;
  disabled?: boolean;
  sessionId: string;
}

const BAR_SHAPES = [0.48, 0.76, 1, 0.7, 0.9, 0.64, 1, 0.76, 0.48];

interface VoiceComposerPresenceProps {
  activeError: string | null;
  isConnecting: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  voiceEnabled: boolean;
}

/** The only voice UI subtree subscribed to high-frequency microphone levels. */
const VoiceComposerPresence: React.FC<VoiceComposerPresenceProps> = ({
  activeError,
  isConnecting,
  isSpeaking,
  isUserSpeaking,
  voiceEnabled,
}) => {
  const audioLevel = useAudioStore((state) => state.voiceModeStates[APP_VOICE_SESSION_ID]?.audioLevel || 0);
  const transcript = useAudioStore((state) => state.voiceModeStates[APP_VOICE_SESSION_ID]?.transcript || '');
  const agentResponse = useAudioStore((state) => state.voiceModeStates[APP_VOICE_SESSION_ID]?.agentResponse || '');
  const settings = useAudioStore((state) => state.settings);
  const updateSettings = useAudioStore((state) => state.updateSettings);

  const presenceLabel = isConnecting
    ? 'Connecting…'
    : isSpeaking
      ? 'Build is speaking'
      : isUserSpeaking
        ? 'Listening to you'
        : 'Listening';
  const presenceDetail = activeError
    || (isSpeaking ? agentResponse : '')
    || (isUserSpeaking ? transcript : '')
    || 'Ask about this tab or any active Build session.';
  const barScales = useMemo(() => {
    const level = Math.max(0.22, Math.min(1, audioLevel * 3.2));
    return BAR_SHAPES.map((shape) => Math.max(0.18, Math.min(1, level * shape)));
  }, [audioLevel]);

  return (
    <div className="build-voice-composer-stage" data-testid="voice-composer-presence">
      <div className="build-voice-composer-copy">
        <div className="build-voice-composer-label">{presenceLabel}</div>
        <div className="build-voice-composer-detail" title={presenceDetail}>{presenceDetail}</div>
      </div>

      <div className="build-voice-composer-orb" aria-label={presenceLabel} role="status">
        <span className="build-voice-orb-glow" aria-hidden="true" />
        <span className="build-voice-orb-ring" aria-hidden="true" />
        <span className="build-voice-orb-core" aria-hidden="true">
          {isConnecting ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : (
            <span className="build-voice-composer-bars">
              {BAR_SHAPES.map((_, index) => (
                <span
                  key={index}
                  style={isUserSpeaking
                    ? { transform: `scaleY(${barScales[index]})` }
                    : { animationDelay: `${-index * 71}ms` }}
                />
              ))}
            </span>
          )}
        </span>
      </div>

      <label
        className="build-voice-composer-picker"
        title="Change realtime voice. Moneypenny keeps Marin's timbre with Build's modern British secret-agent speaking style."
      >
        <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
        <select
          aria-label="Realtime voice"
          data-testid="app-voice-picker"
          value={settings?.realtimeVoice || 'marin'}
          onChange={(event) => {
            const realtimeVoice = event.target.value as RealtimeVoiceOption;
            void updateSettings({ realtimeVoice });
          }}
          disabled={!voiceEnabled}
        >
          {REALTIME_VOICE_OPTIONS.map((voice) => (
            <option key={voice} value={voice}>{getRealtimeVoiceLabel(voice)}</option>
          ))}
        </select>
      </label>
    </div>
  );
};

/** Small, pane-safe view of the singleton app-level realtime voice session. */
export const VoiceComposerControl: React.FC<VoiceComposerControlProps> = ({ active, disabled = false, sessionId }) => {
  const isConnected = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnected));
  const isConnecting = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnecting));
  const isSpeaking = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isSpeaking));
  const isUserSpeaking = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isUserSpeaking));
  const activeError = useAudioStore((state) => state.voiceModeStates[APP_VOICE_SESSION_ID]?.error || null);
  const settings = useAudioStore((state) => state.settings);
  const sessionIsSsh = useSessionStore((state) => Boolean(
    state.sessions.find((candidate) => candidate.id === sessionId)?.sshConfig,
  ));
  const [remoteVoice, setRemoteVoice] = useState<RemoteVoiceDeploymentStatus>({ active: false });
  const [showRemoteVoice, setShowRemoteVoice] = useState(false);
  const [remoteVoiceBusy, setRemoteVoiceBusy] = useState(false);

  const voiceEnabled = settings?.voiceModeEnabled !== false;
  const shortcutLabel = /mac/i.test(navigator.platform) ? '⌘⇧Y' : 'Ctrl+Shift+Y';
  const expanded = active && (isConnected || isConnecting);

  const presenceState = activeError
    ? 'is-error'
    : isConnecting
      ? 'is-connecting'
      : isSpeaking
        ? 'is-agent-speaking'
        : isUserSpeaking
          ? 'is-user-speaking'
          : isConnected
            ? 'is-listening'
            : 'is-idle';
  const title = !voiceEnabled
    ? 'Enable OpenAI Realtime voice in Settings'
    : activeError
      ? `Voice error: ${activeError}`
      : isConnecting
        ? 'Connecting to OpenAI Realtime…'
        : isConnected
          ? 'Voice is on — click to disconnect'
          : 'Talk to Build';

  const toggleVoice = async () => {
    if (disabled || isConnecting || !voiceEnabled) return;
    if (!active) {
      await Promise.resolve(useSessionStore.getState().setActiveSession(sessionId));
    }
    window.dispatchEvent(new CustomEvent('grep-voice-toggle'));
  };

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.voice.getRemoteAgentStatus().then((status) => {
      if (!cancelled) setRemoteVoice(status);
    });
    return () => { cancelled = true; };
  }, []);

  const deployRemoteVoice = async () => {
    if (disabled || remoteVoiceBusy || !sessionIsSsh) return;
    if (!active) await Promise.resolve(useSessionStore.getState().setActiveSession(sessionId));
    setRemoteVoiceBusy(true);
    setShowRemoteVoice(true);
    setRemoteVoice((current) => ({
      ...current,
      active: false,
      deploying: true,
      sessionId,
      error: undefined,
    }));
    try {
      const status = await window.electronAPI.voice.deployRemoteAgent(sessionId);
      setRemoteVoice(status);
      if (status.url) await navigator.clipboard.writeText(status.url).catch(() => undefined);
    } catch (deployError) {
      setRemoteVoice({
        active: false,
        sessionId,
        error: deployError instanceof Error ? deployError.message : 'Remote Voice deployment failed.',
      });
    } finally {
      setRemoteVoiceBusy(false);
    }
  };

  const stopRemoteVoice = async () => {
    if (remoteVoiceBusy) return;
    setRemoteVoiceBusy(true);
    try {
      const status = await window.electronAPI.voice.stopRemoteAgent();
      setRemoteVoice(status);
      setShowRemoteVoice(false);
    } finally {
      setRemoteVoiceBusy(false);
    }
  };

  const remoteVoiceOwnsSession = remoteVoice.active && remoteVoice.sessionId === sessionId;

  return (
    <div className={`build-voice-composer-control build-voice-presence ${presenceState}`}>
      {expanded && (
        <VoiceComposerPresence
          activeError={activeError}
          isConnecting={isConnecting}
          isSpeaking={isSpeaking}
          isUserSpeaking={isUserSpeaking}
          voiceEnabled={voiceEnabled}
        />
      )}

      <button
        type="button"
        onClick={() => { void toggleVoice(); }}
        disabled={disabled || isConnecting || !voiceEnabled}
        className="build-voice-composer-toggle"
        title={`${title} (${shortcutLabel})`}
        aria-label={`${title} (${shortcutLabel})`}
        aria-pressed={isConnected}
        data-testid="app-voice-control"
      >
        {isConnecting ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}
        {(isConnected || activeError) && <span className="build-voice-composer-toggle-dot" aria-hidden="true" />}
      </button>

      <button
        type="button"
        onClick={() => {
          if (remoteVoiceOwnsSession && remoteVoice.url) setShowRemoteVoice((visible) => !visible);
          else void deployRemoteVoice();
        }}
        disabled={disabled || remoteVoiceBusy || !sessionIsSsh}
        className="build-voice-composer-toggle build-remote-voice-toggle"
        title={!sessionIsSsh
          ? 'Remote Agent currently supports SSH sessions'
          : remoteVoiceOwnsSession
            ? 'Remote Agent is live — show QR code and Tailnet URL'
            : 'Deploy Remote Agent with voice and chat to this SSH session'}
        aria-label={remoteVoiceOwnsSession ? 'Show Remote Agent QR code' : 'Deploy Remote Agent to this SSH session'}
        aria-pressed={remoteVoiceOwnsSession}
        data-testid="remote-voice-control"
      >
        {remoteVoiceBusy ? <Loader2 size={15} className="animate-spin" /> : <RadioTower size={15} />}
        {remoteVoiceOwnsSession && <span className="build-voice-composer-toggle-dot" aria-hidden="true" />}
      </button>

      {showRemoteVoice && (
        <div className="build-remote-voice-popover" data-testid="remote-voice-popover">
          <div className="build-remote-voice-popover-head">
            <div>
              <span className={`build-remote-voice-status-dot ${remoteVoice.active ? 'is-live' : ''}`} />
              {remoteVoice.deploying || remoteVoiceBusy ? 'Deploying Remote Agent' : remoteVoice.active ? 'Remote Agent is live' : 'Remote Agent failed'}
            </div>
            <button type="button" onClick={() => setShowRemoteVoice(false)} aria-label="Close Remote Agent details"><X size={13} /></button>
          </div>
          {remoteVoice.url ? (
            <>
              <div className="build-remote-voice-session">{remoteVoice.sessionName} · {remoteVoice.host}</div>
              <div className="build-remote-voice-share">
                <div className="build-remote-voice-qr" aria-label="Scan to open Remote Agent">
                  <QRCodeSVG
                    value={remoteVoice.url}
                    size={128}
                    level="M"
                    marginSize={1}
                    bgColor="#ffffff"
                    fgColor="#090b10"
                  />
                </div>
                <div className="build-remote-voice-share-copy">
                  <div className="build-remote-voice-scan-label">Scan for voice + chat</div>
                  <code className="build-remote-voice-url">{remoteVoice.url}</code>
                  <div className="build-remote-voice-actions">
                    <button type="button" onClick={() => { void navigator.clipboard.writeText(remoteVoice.url || ''); }}><Copy size={12} /> Copy</button>
                    <button type="button" onClick={() => { if (remoteVoice.url) void window.electronAPI.app.openExternal(remoteVoice.url); }}><ExternalLink size={12} /> Open</button>
                  </div>
                </div>
              </div>
              <div className="build-remote-voice-popover-foot">
                <div className="build-remote-voice-note">Tailnet only. Runs on the SSH host even after Build closes.</div>
                <button type="button" className="build-remote-voice-stop" onClick={() => { void stopRemoteVoice(); }}>Stop</button>
              </div>
            </>
          ) : remoteVoice.error ? (
            <div className="build-remote-voice-error">{remoteVoice.error}</div>
          ) : (
            <div className="build-remote-voice-progress"><Loader2 size={14} className="animate-spin" /> Installing the standalone Build CLI on the SSH host…</div>
          )}
        </div>
      )}
    </div>
  );
};
