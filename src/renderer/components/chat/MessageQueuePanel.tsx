import React, { useState, useCallback } from 'react';
import { X, Layers, ArrowUp, Pencil, Check } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';

const EMPTY_QUEUE: never[] = [];

interface MessageQueuePanelProps {
  sessionId: string;
}

export const MessageQueuePanel: React.FC<MessageQueuePanelProps> = ({ sessionId }) => {
  const queue = useSessionStore(useCallback((s) => s.messageQueue[sessionId] || EMPTY_QUEUE, [sessionId]));
  const isStreaming = useSessionStore(useCallback((s) => s.isStreaming[sessionId] || false, [sessionId]));
  const activeStreamModel = useSessionStore(useCallback((s) => s.activeStreamModel[sessionId], [sessionId]));
  const removeFromQueue = useSessionStore((s) => s.removeFromQueue);
  const editQueuedMessage = useSessionStore((s) => s.editQueuedMessage);
  const moveToFront = useSessionStore((s) => s.moveToFront);
  const clearQueue = useSessionStore((s) => s.clearQueue);
  const fastStack = useSessionStore((s) => s.fastStack);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // Keep an in-flight steer visible until the harness acknowledges it. Main
  // removes the row atomically after Query.streamInput or turn/steer succeeds.
  if (queue.length === 0) {
    return null;
  }

  const queueWillSteer = isStreaming && Boolean(
    activeStreamModel?.startsWith('codex:') || activeStreamModel?.startsWith('claude'),
  );

  const handleSaveEdit = (id: string) => {
    if (editText.trim()) {
      editQueuedMessage(sessionId, id, editText.trim());
    }
    setEditingId(null);
    setEditText('');
  };

  const handleFastStack = (id: string, message: string, attachments?: unknown[], suppressUserMessage?: boolean) => {
    void fastStack(sessionId, message, attachments, id, suppressUserMessage);
  };

  return (
    <div className="mb-1.5 bg-ink-1 text-[12.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
      {/* Compact header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line">
        <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
          {queueWillSteer ? 'Steering' : 'Queue'} <span className="font-mono">({queue.length})</span>
        </span>
        {queue.length > 1 && (
          <button
            onClick={() => clearQueue(sessionId)}
            className="text-[11.5px] text-fg-4 hover:text-diff-del-text"
          >
            Clear
          </button>
        )}
      </div>

      {/* Compact queue list */}
      <div className="max-h-32 overflow-y-auto">
        {queue.map((item, index) => (
          <div
            key={item.id}
            className={`flex items-start gap-2 px-3 py-1.5 ${
              index === 0 ? 'bg-white/[0.02]' : ''
            } ${index > 0 ? 'border-t border-line' : ''}`}
          >
            {/* Position indicator */}
            <span className={`flex-shrink-0 w-4 text-center font-mono text-[11px] leading-[18px] ${
              index === 0 ? 'text-accent' : 'text-fg-5'
            }`}>
              {index === 0 ? '>' : index + 1}
            </span>

            {/* Message content */}
            {editingId === item.id ? (
              <div className="flex-1 flex items-center gap-1">
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit(item.id);
                    if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
                  }}
                  className="flex-1 bg-ink-3 px-2 py-1 text-[12.5px] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.6)]"
                  autoFocus
                />
                <button
                  onClick={() => handleSaveEdit(item.id)}
                  className="p-0.5 text-accent hover:text-accent-text"
                  title="Save"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={() => { setEditingId(null); setEditText(''); }}
                  className="p-0.5 text-fg-4 hover:text-fg"
                  title="Cancel"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <>
                <span className="flex-1 text-fg-2 leading-[18px] break-words whitespace-pre-wrap">
                  {item.message}
                </span>

                {/* Compact action icons */}
                <div className="flex-shrink-0 flex items-center gap-0.5 opacity-50 hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingId(item.id); setEditText(item.message); }}
                    className="p-0.5 text-fg-4 hover:text-fg"
                    title="Edit"
                  >
                    <Pencil size={11} />
                  </button>
                  {index !== 0 && (
                    <button
                      onClick={() => moveToFront(sessionId, item.id)}
                      className="p-0.5 text-fg-4 hover:text-accent-text"
                      title="Move to front"
                    >
                      <ArrowUp size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => handleFastStack(item.id, item.message, item.attachments, item.suppressUserMessage)}
                    className="inline-flex items-center gap-1 px-1 py-0.5 text-[11px] text-fg-4 hover:text-amber"
                    title="Fast Stack — fork now and run in this chat (⌘⇧↵)"
                  >
                    <Layers size={11} />
                    <span>Stack</span>
                  </button>
                  <button
                    onClick={() => removeFromQueue(sessionId, item.id)}
                    className="p-0.5 text-fg-4 hover:text-diff-del-text"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
