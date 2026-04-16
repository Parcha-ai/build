import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Square } from 'lucide-react';
import { useSessionStore, type PermissionMode } from '../../stores/session.store';
import CommandAutocomplete from '../chat/CommandAutocomplete';

const PERMISSION_PROMPTS: Record<PermissionMode, { prompt: string; color: string }> = {
  auto: { prompt: '⚡', color: 'text-cyan-400' },
  acceptEdits: { prompt: '>>', color: 'text-green-400' },
  default: { prompt: '>', color: 'text-amber-400' },
  bypassPermissions: { prompt: '>>>', color: 'text-purple-400' },
  plan: { prompt: '?', color: 'text-blue-400' },
  dontAsk: { prompt: '#', color: 'text-gray-500' },
};

interface CompactInputAreaProps {
  sessionId: string;
  disabled?: boolean;
  isStreaming: boolean;
}

export default function CompactInputArea({ sessionId, disabled, isStreaming }: CompactInputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const cancelStream = useSessionStore((s) => s.cancelStream);
  const permissionMode = useSessionStore(useCallback((s) => s.permissionMode[sessionId] || 'bypassPermissions', [sessionId]));

  // Command/skill autocomplete state
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandType, setCommandType] = useState<'command' | 'skill' | 'agent'>('command');
  const [commandPosition, setCommandPosition] = useState({ top: 0, left: 0 });
  const [commandStartIndex, setCommandStartIndex] = useState(-1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [commands, setCommands] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [skills, setSkills] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [agents, setAgents] = useState<any[]>([]);

  // Load commands/skills/agents for this session
  useEffect(() => {
    const currentSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (!currentSession) return;
    const projectPath = currentSession.worktreePath;
    Promise.all([
      window.electronAPI.extensions.scanCommands({ sessionId, projectPath }),
      window.electronAPI.extensions.scanSkills({ sessionId, projectPath }),
      window.electronAPI.extensions.scanAgents({ sessionId, projectPath }),
    ]).then(([cmds, skls, agts]) => {
      setCommands(cmds);
      setSkills(skls);
      setAgents(agts);
    }).catch(err => {
      console.error('[CompactInputArea] Error loading extensions:', err);
    });
  }, [sessionId]);

  const config = PERMISSION_PROMPTS[permissionMode];

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    sendMessage(sessionId, trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, disabled, sessionId, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && showCommands) {
      setShowCommands(false);
    }
  }, [handleSend, showCommands]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setInput(value);

    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 80) + 'px';

    // Detect slash commands
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/');
    if (lastSlashIndex !== -1) {
      const textAfterSlash = textBeforeCursor.slice(lastSlashIndex + 1);
      const charBeforeSlash = value[lastSlashIndex - 1];
      const isValidStart = lastSlashIndex === 0 || /\s/.test(charBeforeSlash);
      const hasNoSpaces = !/\s/.test(textAfterSlash);

      if (isValidStart && hasNoSpaces) {
        if (containerRef.current) {
          const containerRect = containerRef.current.getBoundingClientRect();
          setCommandPosition({
            top: Math.max(10, containerRect.top - 270),
            left: containerRect.left,
          });
        }
        setShowCommands(true);
        setCommandType('command');
        setCommandQuery(textAfterSlash);
        setCommandStartIndex(lastSlashIndex);
        return;
      }
    }

    // Check for @agent- mentions
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      const charBeforeAt = value[lastAtIndex - 1];
      const isValidStart = lastAtIndex === 0 || /\s/.test(charBeforeAt);
      const hasNoSpaces = !/\s/.test(textAfterAt);

      if (isValidStart && hasNoSpaces && textAfterAt.startsWith('agent-')) {
        if (containerRef.current) {
          const containerRect = containerRef.current.getBoundingClientRect();
          setCommandPosition({
            top: Math.max(10, containerRect.top - 270),
            left: containerRect.left,
          });
        }
        setShowCommands(true);
        setCommandType('agent');
        setCommandQuery(textAfterAt.replace('agent-', ''));
        setCommandStartIndex(lastAtIndex);
        return;
      }
    }

    setShowCommands(false);
    setCommandQuery('');
    setCommandStartIndex(-1);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCommandSelect = useCallback(async (item: any) => {
    const currentSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    const projectPath = currentSession?.worktreePath;
    const itemType = item.itemType || commandType;

    if (itemType === 'command') {
      try {
        const content = await window.electronAPI.extensions.getCommand(item.name, projectPath);
        if (content) {
          const lines = content.split('\n');
          const cleanContent = lines.filter((l: string) => !l.trim().startsWith('<!--')).join('\n').trim();
          const beforeCommand = input.slice(0, commandStartIndex);
          const afterCommand = input.slice(commandStartIndex + item.name.length + 1);
          setInput(beforeCommand + cleanContent + (afterCommand ? ' ' + afterCommand : ''));
        }
      } catch (err) {
        console.error('[CompactInputArea] Error loading command:', err);
      }
    } else if (itemType === 'skill') {
      const before = input.slice(0, commandStartIndex);
      setInput(before + `/${item.name}`);
    } else if (itemType === 'agent') {
      const before = input.slice(0, commandStartIndex);
      setInput(before + `@agent-${item.name}`);
    }

    setShowCommands(false);
    setCommandQuery('');
    setCommandStartIndex(-1);
    textareaRef.current?.focus();
  }, [input, commandStartIndex, commandType, sessionId]);

  return (
    <div ref={containerRef} className="border-t border-claude-border px-2 py-1.5 bg-claude-surface/50 relative">
      <div className="flex items-end gap-1.5">
        <span className={`${config.color} font-bold text-xs leading-6 flex-shrink-0`}>
          {config.prompt}
        </span>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Session not running' : 'Message...'}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-claude-text text-xs font-mono resize-none focus:outline-none placeholder:text-claude-text-secondary/50 leading-5"
          style={{ minHeight: '20px', maxHeight: '80px' }}
        />
        {isStreaming && (
          <button
            onClick={() => cancelStream(sessionId)}
            className="p-0.5 text-red-400 hover:bg-red-400/20 flex-shrink-0"
            style={{ borderRadius: 0 }}
            title="Stop"
          >
            <Square size={12} />
          </button>
        )}
      </div>

      {/* Command/Skill/Agent Autocomplete */}
      {showCommands && (
        <CommandAutocomplete
          query={commandQuery}
          type={commandType}
          commands={commands}
          skills={skills}
          agents={agents}
          position={commandPosition}
          onSelect={handleCommandSelect}
          onClose={() => setShowCommands(false)}
        />
      )}
    </div>
  );
}
