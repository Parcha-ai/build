import React, { useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, ExternalLink } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';

interface RemoteControlPanelProps {
  sessionId: string;
  url: string;
  startedAt: Date;
}

export default function RemoteControlPanel({ sessionId, url, startedAt }: RemoteControlPanelProps) {
  const stopRemoteControl = useSessionStore((s) => s.stopRemoteControl);

  const handleCopy = () => {
    navigator.clipboard.writeText(url);
  };

  const handleOpenExternal = () => {
    window.electronAPI?.app.openExternal(url);
  };

  const handleStop = () => {
    stopRemoteControl(sessionId);
  };

  const elapsed = useMemo(() => {
    const diff = Date.now() - new Date(startedAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just started';
    return `${mins}m`;
  }, [startedAt]);

  return (
    <div className="mx-3 mb-1.5 bg-ink-1 text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]" style={{ borderRadius: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">REMOTE CONTROL</span>
          <span className="inline-block w-[7px] h-[7px] rounded-full bg-diff-add animate-pulse" />
          <span className="font-mono text-[10.5px] text-fg-5">{elapsed}</span>
        </div>
        <button
          onClick={handleStop}
          className="h-6 px-2 text-[11.5px] text-diff-del-text hover:bg-diff-del/10"
          style={{ borderRadius: 0 }}
        >
          STOP
        </button>
      </div>

      {/* Content */}
      <div className="flex items-start gap-4 px-3 py-3">
        {/* QR Code */}
        <div className="shrink-0 p-1 bg-white">
          <QRCodeSVG value={url} size={96} level="M" />
        </div>

        {/* URL and actions */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-fg-4 uppercase tracking-[0.04em] font-medium mb-1.5">Scan QR code or open URL</p>
          <div className="flex items-center gap-1 mb-2">
            <code className="font-mono text-[11.5px] text-fg-2 truncate block flex-1 bg-[#0B0B0B] px-2 py-1">
              {url}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 h-7 px-2.5 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/[0.04] hover:text-fg"
              style={{ borderRadius: 0 }}
            >
              <Copy size={12} />
              COPY
            </button>
            <button
              onClick={handleOpenExternal}
              className="flex items-center gap-1.5 h-7 px-2.5 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/[0.04] hover:text-fg"
              style={{ borderRadius: 0 }}
            >
              <ExternalLink size={12} />
              OPEN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
