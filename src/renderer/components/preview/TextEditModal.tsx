import React, { useState, useEffect } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';

interface TextSelection {
  text: string;
  context: {
    before: string;
    after: string;
    parentTag: string;
    parentSelector: string;
    reactComponent?: string;
  };
  boundingRect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
}

interface TextEditModalProps {
  textSelection: TextSelection;
  currentUrl: string;
  sessionId: string;
  onClose: () => void;
}

export const TextEditModal: React.FC<TextEditModalProps> = ({
  textSelection,
  currentUrl,
  sessionId,
  onClose,
}) => {
  const [replacementText, setReplacementText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const sendMessage = useSessionStore(s => s.sendMessage);
  const setSessionEditingText = useUIStore(s => s.setSessionEditingText);

  // Auto-focus input on mount
  useEffect(() => {
    const timeout = setTimeout(() => {
      document.getElementById('replacement-text-input')?.focus();
    }, 100);
    return () => clearTimeout(timeout);
  }, []);

  const handleSubmit = async () => {
    if (!replacementText.trim() || !sessionId) return;

    setIsSubmitting(true);
    setSessionEditingText(sessionId, true); // Trigger loading animation

    // Construct detailed prompt for Claude
    const prompt = constructEditPrompt(
      textSelection.text,
      replacementText,
      textSelection.context,
      currentUrl
    );

    console.log('[TextEditModal] Sending edit request to Claude:', prompt);

    // Send message to Claude via existing message injection
    await sendMessage(sessionId, prompt, []);

    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const contextDisplay = `<${textSelection.context.parentTag}> ...${textSelection.context.before} [${textSelection.text}] ${textSelection.context.after}...`;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.45)] w-[500px] max-w-[90vw]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-fg">Replace Text</h3>
          <button
            onClick={onClose}
            className="text-fg-4 hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Original Text */}
          <div>
            <label className="block text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1.5">
              Original Text:
            </label>
            <div className="px-3 py-2 bg-ink-3 text-[13px] text-fg break-words">
              {textSelection.text}
            </div>
          </div>

          {/* Replacement Input */}
          <div>
            <label htmlFor="replacement-text-input" className="block text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1.5">
              Replace With:
            </label>
            <input
              id="replacement-text-input"
              type="text"
              value={replacementText}
              onChange={(e) => setReplacementText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter replacement text..."
              className="w-full px-3 py-2 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder-fg-5 focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.6)]"
            />
          </div>

          {/* Context Preview */}
          <div>
            <label className="block text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1.5">
              Context:
            </label>
            <div className="px-3 py-2 bg-[#0B0B0B] text-[12px] text-fg-3 font-mono break-all">
              {contextDisplay}
            </div>
          </div>

          {textSelection.context.reactComponent && (
            <div className="text-[11.5px] text-fg-4">
              React Component: <span className="font-mono">{textSelection.context.reactComponent}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!replacementText.trim() || isSubmitting}
            className="h-8 px-3.5 bg-[#EDEDED] text-[#0F0F0F] text-[13px] font-semibold hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Sending...' : 'Replace Text'}
          </button>
        </div>
      </div>
    </div>
  );
};

function constructEditPrompt(
  originalText: string,
  replacementText: string,
  context: TextSelection['context'],
  currentUrl: string
): string {
  return `I need you to replace text in the UI for the page at ${currentUrl}.

**Original Text**: "${originalText}"
**Replacement Text**: "${replacementText}"

**Context**:
- Parent element: <${context.parentTag}>
- CSS selector: ${context.parentSelector}
${context.reactComponent ? `- React component: ${context.reactComponent}` : ''}
- Surrounding text: ...${context.before} [TARGET] ${context.after}...

Please:
1. Find the source file that renders this UI element
2. Locate the exact occurrence of "${originalText}" in the code
3. Replace it with "${replacementText}"
4. If there are multiple occurrences, use the context above to determine which one

Use the Edit tool to make the change. The page will reload automatically once you're done.`;
}
