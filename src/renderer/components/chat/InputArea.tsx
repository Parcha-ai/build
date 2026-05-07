import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { X, Image, FileCode, Target, File, Folder, AtSign, Brain, Square, Code, Smartphone, RefreshCw, Slash, Eraser } from 'lucide-react';
import { useSessionStore, type PermissionMode, type ThinkingMode, type EffortLevel, migrateThinkingMode, normalizePermissionModeForModel } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useAudioStore } from '../../stores/audio.store';
import MentionAutocomplete, { type Mention } from './MentionAutocomplete';
import CommandAutocomplete, { type CommandAutocompleteHandle } from './CommandAutocomplete';
import { MicrophoneButton, type VoiceModeHandle } from './MicrophoneButton';
import { MessageQueuePanel } from './MessageQueuePanel';
import { VoiceModeErrorBoundary } from './VoiceModeErrorBoundary';
import SecureInput from './SecureInput';
import CompactionSwitchNotice from './CompactionSwitchNotice';
import { GSTACK_MODE_META } from '../../../shared/types';

// Permission mode config for UI - using terminal-style prompts
const PERMISSION_MODE_CONFIG: Record<PermissionMode, { prompt: string; label: string; color: string; description: string }> = {
  auto: {
    prompt: '⚡',
    label: 'AUTO',
    color: 'text-cyan-400',
    description: 'Smart auto-approve — Claude decides when to ask',
  },
  acceptEdits: {
    prompt: '>>',
    label: 'ACCEPT EDITS',
    color: 'text-green-400',
    description: 'Auto-accept edits',
  },
  default: {
    prompt: '>',
    label: 'ASK',
    color: 'text-amber-400',
    description: 'Require approval',
  },
  bypassPermissions: {
    prompt: '>>>',
    label: 'BYPASS',
    color: 'text-purple-400',
    description: 'Bypass all permissions — full autonomous',
  },
  plan: {
    prompt: '?',
    label: 'PLAN',
    color: 'text-blue-400',
    description: 'Planning mode (no execution)',
  },
  dontAsk: {
    prompt: '#',
    label: 'DENY',
    color: 'text-gray-500',
    description: "Don't ask (deny if not pre-approved)",
  },
};

// Effort level config for UI (replaces thinking mode)
const EFFORT_LEVEL_CONFIG: Record<ThinkingMode, { label: string; color: string; description: string; opusOnly?: boolean }> = {
  // Legacy values (for backward compatibility during migration)
  off: {
    label: 'LOW',
    color: 'text-gray-400',
    description: 'Fast & efficient - minimal thinking',
  },
  thinking: {
    label: 'MED',
    color: 'text-blue-400',
    description: 'Balanced - moderate thinking (10k tokens)',
  },
  ultrathink: {
    label: 'HIGH',
    color: 'text-purple-400',
    description: 'Full capability - deep thinking (default)',
  },
  // New effort levels
  low: {
    label: 'LOW',
    color: 'text-gray-400',
    description: 'Fast & efficient - minimal thinking',
  },
  medium: {
    label: 'MED',
    color: 'text-blue-400',
    description: 'Balanced - moderate thinking (10k tokens)',
  },
  high: {
    label: 'HIGH',
    color: 'text-purple-400',
    description: 'Full capability - deep thinking (default)',
  },
  xhigh: {
    label: 'XHIGH',
    color: 'text-orange-400',
    description: 'Extended deep thinking - more thorough reasoning',
    opusOnly: true,
  },
  max: {
    label: 'MAX',
    color: 'text-pink-400',
    description: 'Maximum capability (Opus only)',
    opusOnly: true,
  },
};

interface SystemInfo {
  tools: string[];
  model: string;
}

// GStack skill launcher — discovers real gstack skills from disk and invokes them via /command messages
function GStackLauncher({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [skills, setSkills] = useState<Array<{ id: string; name: string; shortName: string; description: string; color: string; category: string }>>([]);
  const [isInstalled, setIsInstalled] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);
  const sendMessage = useSessionStore((s) => s.sendMessage);

  useEffect(() => {
    window.electronAPI.gstack.isInstalled().then(installed => {
      setIsInstalled(installed);
      if (installed) {
        window.electronAPI.gstack.getModes().then(setSkills).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleInstall = async () => {
    setIsInstalling(true);
    const result = await window.electronAPI.gstack.install();
    setIsInstalling(false);
    if (result.success) {
      setIsInstalled(true);
      const modes = await window.electronAPI.gstack.getModes();
      setSkills(modes);
    }
  };

  const handleSelect = (skillId: string) => {
    onClose();
    // Send /{skillId} as a message — Claude Code invokes the real gstack skill
    sendMessage(sessionId, `/${skillId}`);
  };

  // Group skills by category
  const categories = ['Strategy', 'Design', 'Development', 'Testing', 'Analysis', 'Safety'];
  const grouped = categories.map(cat => ({
    label: cat,
    skills: skills.filter(s => s.category === cat),
  })).filter(g => g.skills.length > 0);

  return (
    <div
      ref={menuRef}
      className="fixed w-72 bg-claude-surface border border-claude-border shadow-xl z-50 overflow-hidden"
      style={{ bottom: '80px', maxHeight: 'calc(100vh - 120px)', borderRadius: 0 }}
    >
      <div className="px-3 py-1.5 border-b border-claude-border flex items-center justify-between">
        <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">GStack Skills</span>
        {isInstalled && (
          <span className="text-[9px] text-green-400 font-mono">{skills.length} skills</span>
        )}
      </div>

      {!isInstalled ? (
        <div className="p-3 text-center">
          <p className="text-xs text-claude-text-secondary mb-2">
            GStack is not installed. Install Garry Tan's Claude Code operating system?
          </p>
          <button
            onClick={handleInstall}
            disabled={isInstalling}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold uppercase disabled:opacity-50"
            style={{ borderRadius: 0, letterSpacing: '0.05em' }}
          >
            {isInstalling ? 'Installing...' : 'Install GStack'}
          </button>
        </div>
      ) : (
        <div className="py-0.5 max-h-[400px] overflow-y-auto">
          {grouped.map((group, gi) => (
            <div key={group.label}>
              {gi > 0 && <div className="mx-2 my-0.5 border-t border-claude-border" />}
              <div className="px-3 py-0.5">
                <span className="text-[9px] font-semibold text-claude-text-secondary uppercase tracking-wider">{group.label}</span>
              </div>
              {group.skills.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => handleSelect(skill.id)}
                  className="w-full px-3 py-1 flex items-center gap-2 hover:bg-white/5 transition-colors text-left"
                >
                  <span
                    className="text-[9px] font-bold font-mono px-1 flex-shrink-0"
                    style={{ backgroundColor: `${skill.color}25`, color: skill.color }}
                  >
                    {skill.shortName}
                  </span>
                  <div className="min-w-0">
                    <span className="text-xs text-claude-text truncate block">/{skill.id}</span>
                    <span className="text-[10px] text-claude-text-secondary truncate block">{skill.description}</span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface InputAreaProps {
  sessionId: string;
  disabled?: boolean;
  systemInfo?: SystemInfo | null;
  isStreaming?: boolean;
}

interface Attachment {
  type: 'file' | 'image' | 'dom_element' | 'mention';
  name: string;
  content: string;
  path?: string;
  subType?: 'file' | 'folder' | 'symbol'; // For mentions: preserves the original type
}

// Stable empty arrays to avoid reference changes when session data is missing
const EMPTY_QUEUE: never[] = [];
const EMPTY_MODELS: never[] = [];

export default function InputArea({ sessionId, disabled, systemInfo, isStreaming: isStreamingProp }: InputAreaProps) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [escapeKeyCount, setEscapeKeyCount] = useState(0);
  const [escapeTimeout, setEscapeTimeout] = useState<NodeJS.Timeout | null>(null);
  const [showEscapeWarning, setShowEscapeWarning] = useState(false);

  // GStack skill launcher
  const [showGStack, setShowGStack] = useState(false);

  // Message history state
  const [messageHistory, setMessageHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const commandAutocompleteRef = useRef<CommandAutocompleteHandle>(null);
  const voiceModeRef = useRef<VoiceModeHandle>(null);
  const blurFromBrowserEditRef = useRef(false);

  // Helper to safely get selection position
  const getSelectionStart = (): number | undefined => {
    return textareaRef.current?.selectionStart ?? undefined;
  };

  // Per-session data selectors — only re-render when THIS session's data changes
  const isStreamingState = useSessionStore(useCallback((s) => s.isStreaming[sessionId] || false, [sessionId]));
  const currentMode = useSessionStore(useCallback((s) => normalizePermissionModeForModel(
    s.selectedModel[sessionId] || 'claude-opus-4-7',
    s.permissionMode[sessionId],
  ), [sessionId]));
  const contextUsage = useSessionStore(useCallback((s) => s.contextUsage[sessionId] || null, [sessionId]));
  const currentThinkingMode = useSessionStore(useCallback((s) => s.thinkingMode[sessionId] || 'thinking', [sessionId]));
  const activeGStackMode = useSessionStore(useCallback((s) => s.gstackMode[sessionId] || null, [sessionId]));
  const queuedMessages = useSessionStore(useCallback((s) => s.messageQueue[sessionId] || EMPTY_QUEUE, [sessionId]));
  const currentModel = useSessionStore(useCallback((s) => s.selectedModel[sessionId] || 'claude-opus-4-7', [sessionId]));
  const compactionSwitch = useSessionStore(useCallback((s) => s.compactionSwitch[sessionId] || null, [sessionId]));
  const availableModels = useSessionStore((s) => s.availableModels || EMPTY_MODELS);

  // Action selectors — stable references, never cause re-renders
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const askBtw = useSessionStore((s) => s.askBtw);
  const remoteControl = useSessionStore(useCallback((s) => s.remoteControl[sessionId] || null, [sessionId]));
  const interruptAndSend = useSessionStore((s) => s.interruptAndSend);
  const pendingPlanApproval = useSessionStore(useCallback((s) => s.pendingPlanApproval[sessionId] || null, [sessionId]));
  const rejectPlan = useSessionStore((s) => s.rejectPlan);
  const cyclePermissionMode = useSessionStore((s) => s.cyclePermissionMode);
  const setGStackMode = useSessionStore((s) => s.setGStackMode);
  const cycleThinkingMode = useSessionStore((s) => s.cycleThinkingMode);
  const setThinkingMode = useSessionStore((s) => s.setThinkingMode);
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel);
  const dismissCompactionSwitch = useSessionStore((s) => s.dismissCompactionSwitch);
  const restoreCompactionModel = useSessionStore((s) => s.restoreCompactionModel);
  const loadAvailableModels = useSessionStore((s) => s.loadAvailableModels);

  // UI store — fine-grained selectors
  const selectedElement = useUIStore((s) => s.selectedElement);
  const setSelectedElement = useUIStore((s) => s.setSelectedElement);
  const sessionInspectorActive = useUIStore((s) => s.sessionInspectorActive);
  const setSessionInspectorActive = useUIStore((s) => s.setSessionInspectorActive);
  const toggleBrowserPanel = useUIStore((s) => s.toggleBrowserPanel);

  // Audio store — fine-grained selectors
  const audioSettings = useAudioStore((s) => s.settings);
  const setAudioMode = useAudioStore((s) => s.setAudioMode);
  const voiceModeStates = useAudioStore((s) => s.voiceModeStates);

  // Voice mode state for this session
  const voiceState = voiceModeStates[sessionId];
  const isVoiceModeActive = voiceState?.isConnected || false;

  // Animation time for wave visualization
  const [waveTime, setWaveTime] = useState(0);
  useEffect(() => {
    if (!isVoiceModeActive) return;
    const interval = setInterval(() => {
      setWaveTime(Date.now() / 200);  // Update ~60fps worth of animation time
    }, 50);  // 20fps is enough for smooth wave animation
    return () => clearInterval(interval);
  }, [isVoiceModeActive]);

  // Command/Skill/Agent autocomplete state
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandType, setCommandType] = useState<'command' | 'skill' | 'agent'>('command');
  const [commandPosition, setCommandPosition] = useState({ top: 0, left: 0 });
  const [commandStartIndex, setCommandStartIndex] = useState(-1);
  const [commands, setCommands] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);

  // Get the configurable trigger word (default: "please")
  const triggerWord = audioSettings?.voiceTriggerWord || 'please';

  const modeConfig = PERMISSION_MODE_CONFIG[currentMode];
  const permissionModeTitle = `${modeConfig.description} (click to change)`;
  // Apply migration for legacy thinking mode values
  const migratedThinkingMode = migrateThinkingMode(currentThinkingMode);
  const effortConfig = EFFORT_LEVEL_CONFIG[migratedThinkingMode] || EFFORT_LEVEL_CONFIG['high'];

  const isSending = isStreamingState || (isStreamingProp ?? false);
  const hasQueuedMessages = queuedMessages.length > 0;

  // Model selector state
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [hoverHarness, setHoverHarness] = useState<string | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Effort level selector state
  const [showEffortDropdown, setShowEffortDropdown] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement>(null);

  // Get current model display name
  const currentModelInfo = useMemo(() => {
    const model = availableModels.find(m => m.id === currentModel);
    return model || { id: currentModel, name: currentModel.split('-').slice(1, 3).join(' ').toUpperCase(), description: '' };
  }, [availableModels, currentModel]);

  // Load available models on mount
  useEffect(() => {
    if (availableModels.length === 0) {
      loadAvailableModels();
    }
  }, []);

  // Load message history from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`grep-history-${sessionId}`);
      if (stored) {
        setMessageHistory(JSON.parse(stored));
      }
    } catch {
      // Ignore parse errors
    }
  }, [sessionId]);

  // Close history dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(event.target as Node)) {
        setShowHistory(false);
        setHistoryIndex(-1);
      }
    };
    if (showHistory) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showHistory]);

  // Close model dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showModelDropdown]);

  // Close effort dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (effortDropdownRef.current && !effortDropdownRef.current.contains(event.target as Node)) {
        setShowEffortDropdown(false);
      }
    };
    if (showEffortDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEffortDropdown]);

  // Listen for text edit events to blur/disable input while editing in browser
  useEffect(() => {
    const handleTextEditActive = (event: CustomEvent<{ active: boolean; sessionId?: string }>) => {
      if (event.detail.sessionId && event.detail.sessionId !== sessionId) {
        return;
      }

      if (event.detail.active) {
        // Blur the textarea when text editing starts
        blurFromBrowserEditRef.current = document.activeElement === textareaRef.current;
        textareaRef.current?.blur();
      } else if (blurFromBrowserEditRef.current) {
        blurFromBrowserEditRef.current = false;
        textareaRef.current?.focus();
      }
    };

    window.addEventListener('grep-text-edit-active', handleTextEditActive as EventListener);
    return () => window.removeEventListener('grep-text-edit-active', handleTextEditActive as EventListener);
  }, [sessionId]);

  // Listen for insert-chat events from browser preview - adds element context as attachments (chips)
  useEffect(() => {
    interface InsertChatDetail {
      sessionId: string;
      content: string;
      screenshot?: string;
      elementContext?: {
        selector: string;
        outerHTML: string;
        tagName: string;
        reactComponent?: string;
      };
    }
    const handleInsertChat = (event: CustomEvent<InsertChatDetail>) => {
      const { sessionId: targetSessionId, content, screenshot, elementContext } = event.detail;
      // Accept events from this session OR any ancestor (BrowserPreview uses root session ID)
      if (targetSessionId !== sessionId) {
        const sessions = useSessionStore.getState().sessions;
        let current = sessions.find(s => s.id === sessionId);
        let isAncestor = false;
        while (current?.parentSessionId) {
          if (current.parentSessionId === targetSessionId) { isAncestor = true; break; }
          current = sessions.find(s => s.id === current!.parentSessionId);
        }
        if (!isAncestor) return;
      }

      console.log('[InputArea] Received grep-insert-chat event');

      const newAttachments: Attachment[] = [];

      // Add element context as a dom_element attachment (shows as chip, sent as context)
      // When both element context AND screenshot exist, combine into one chip
      // (don't create two separate chips for a single inspector click)
      if (elementContext) {
        const displayName = elementContext.reactComponent
          ? `<${elementContext.reactComponent}>`
          : elementContext.selector || `<${elementContext.tagName.toLowerCase()}>`;

        newAttachments.push({
          type: 'dom_element',
          name: displayName,
          content: elementContext.outerHTML,
          screenshot: screenshot || undefined,
        } as Attachment);
      } else if (screenshot) {
        // Standalone screenshot (no element context) — e.g., screenshot button
        newAttachments.push({
          type: 'image',
          name: 'screenshot.png',
          content: screenshot,
        });
      }

      // Add attachments (context shown as chips, no visible text)
      if (newAttachments.length > 0) {
        setAttachments(prev => [...prev, ...newAttachments]);
      }

      // Only set message if there's explicit content (not element metadata)
      if (content && content.trim()) {
        setMessage(prev => {
          if (prev.trim()) {
            return prev + '\n\n' + content;
          }
          return content;
        });
      }

      // Focus the textarea
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    };

    window.addEventListener('grep-insert-chat', handleInsertChat as EventListener);
    return () => window.removeEventListener('grep-insert-chat', handleInsertChat as EventListener);
  }, [sessionId]);

  // Listen for send-annotation events - sends IMMEDIATELY AND populates input for editing option
  useEffect(() => {
    const handleSendAnnotation = (event: CustomEvent<{ sessionId: string; content: string; screenshot?: string; alsoPopulateInput?: boolean }>) => {
      const { sessionId: targetSessionId, content, screenshot, alsoPopulateInput } = event.detail;
      if (targetSessionId !== sessionId) {
        const sessions = useSessionStore.getState().sessions;
        let current = sessions.find(s => s.id === sessionId);
        let isAncestor = false;
        while (current?.parentSessionId) {
          if (current.parentSessionId === targetSessionId) { isAncestor = true; break; }
          current = sessions.find(s => s.id === current!.parentSessionId);
        }
        if (!isAncestor) return;
      }

      console.log('[InputArea] Received grep-send-annotation event - sending immediately');

      // Build attachments array if there's a screenshot
      const annotationAttachments: Attachment[] = [];
      if (screenshot) {
        annotationAttachments.push({
          type: 'image',
          name: 'element-screenshot.png',
          content: screenshot,
        });
      }

      // Send the message immediately
      sendMessage(sessionId, content, annotationAttachments.length > 0 ? annotationAttachments : undefined);

      // Also populate the input and attachments so user can see/edit for next annotation
      if (alsoPopulateInput) {
        setMessage(content);
        if (screenshot) {
          setAttachments([{
            type: 'image',
            name: 'element-screenshot.png',
            content: screenshot,
          }]);
        }
      }
    };

    window.addEventListener('grep-send-annotation', handleSendAnnotation as EventListener);
    return () => window.removeEventListener('grep-send-annotation', handleSendAnnotation as EventListener);
  }, [sessionId, sendMessage]);

  // Handle selected element from browser inspector
  useEffect(() => {
    console.log('[InputArea] selectedElement changed:', selectedElement);
    if (selectedElement) {
      const element = selectedElement as {
        selector: string;
        outerHTML: string;
        screenshot?: string;
        tagName?: string;
        reactComponent?: string;
      };
      console.log('[InputArea] Adding DOM element attachment:', element.selector);

      setAttachments((prev) => {
        const newAttachments = [...prev];

        // Add the DOM element info
        const displayName = element.reactComponent
          ? `${element.reactComponent} (${element.tagName})`
          : element.selector || 'DOM Element';

        newAttachments.push({
          type: 'dom_element' as const,
          name: displayName,
          content: element.outerHTML || '',
        });

        // Add screenshot if available
        if (element.screenshot && element.screenshot.length > 0) {
          console.log('[InputArea] Adding element screenshot, size:', element.screenshot.length);
          newAttachments.push({
            type: 'image' as const,
            name: `element-screenshot-${Date.now()}.png`,
            content: element.screenshot,
          });
        }

        console.log('[InputArea] New attachments count:', newAttachments.length);
        return newAttachments;
      });
      useUIStore.getState().setSelectedElement(null);
    }
  }, [selectedElement]);

  // Load commands, skills, and agents when session changes
  useEffect(() => {
    // Always seed the builtin commands so the autocomplete works even if
    // session lookup or extensions IPC fails (e.g. SSH session before worktree
    // is set up). These are the always-available items.
    const builtinCommands = [
      { name: 'codex', description: 'Get a second opinion from OpenAI Codex', scope: 'builtin', itemType: 'codex' },
      { name: 'monitor', description: '[Claude Code] Watch a long-running process and stream events', scope: 'builtin', itemType: 'claude-code' },
      { name: 'loop', description: '[Claude Code] Run a prompt on a recurring interval', scope: 'builtin', itemType: 'claude-code' },
    ];
    setCommands(builtinCommands as any);

    const currentSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (!currentSession) return;

    const projectPath = currentSession.worktreePath;

    // Load all extensions (pass sessionId for SSH remote scanning)
    Promise.all([
      window.electronAPI.extensions.scanCommands({ sessionId, projectPath }),
      window.electronAPI.extensions.scanSkills({ sessionId, projectPath }),
      window.electronAPI.extensions.scanAgents({ sessionId, projectPath }),
      window.electronAPI.gstack.getModes(),
    ]).then(([cmds, skls, agts, gstackModes]) => {
      // Inject GStack modes as slash commands (e.g. /ceo, /eng, /qa)
      const gstackCommands: Array<{ name: string; description: string; scope: string; itemType: string; gstackId: string | null }> = (gstackModes || []).map((mode: { id: string; shortName: string; description: string }) => ({
        name: mode.shortName.toLowerCase(),
        description: `[GStack] ${mode.description}`,
        scope: 'gstack',
        itemType: 'gstack',
        gstackId: mode.id,
      }));
      // Add /gstack-off to deactivate any active mode
      gstackCommands.push({
        name: 'gstack-off',
        description: '[GStack] Deactivate current workflow mode',
        scope: 'gstack',
        itemType: 'gstack',
        gstackId: null,
      });
      setCommands([...cmds, ...gstackCommands, ...builtinCommands] as any);
      setSkills(skls);
      setAgents(agts);
      console.log('[InputArea] Loaded extensions for session:', sessionId, '- Commands:', cmds.length, 'Skills:', skls.length, 'Agents:', agts.length, 'GStack:', gstackCommands.length);
    }).catch(err => {
      console.error('[InputArea] Error loading extensions:', err);
    });
  }, [sessionId]);

  // Detect @ mentions, slash commands, and @agent mentions in text
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setMessage(value);

    const textBeforeCursor = value.slice(0, cursorPos);

    // Check for slash commands anywhere in input (similar to @mention detection)
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/');
    if (lastSlashIndex !== -1) {
      const textAfterSlash = textBeforeCursor.slice(lastSlashIndex + 1);
      const charBeforeSlash = value[lastSlashIndex - 1];
      const isValidStart = lastSlashIndex === 0 || /\s/.test(charBeforeSlash);
      const hasNoSpaces = !/\s/.test(textAfterSlash);

      if (isValidStart && hasNoSpaces) {
        // Position autocomplete above the input container
        if (containerRef.current) {
          const containerRect = containerRef.current.getBoundingClientRect();

          // Position above the input area (dropdown height ~250px, add margin)
          setCommandPosition({
            top: Math.max(10, containerRect.top - 270), // Ensure at least 10px from top
            left: containerRect.left
          });
        }

        setShowCommands(true);
        setCommandType('command');
        setCommandQuery(textAfterSlash);
        setCommandStartIndex(lastSlashIndex);
        setShowMentions(false);
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

      if (isValidStart && hasNoSpaces) {
        // Check if it's @agent- pattern (for subagents)
        if (textAfterAt.startsWith('agent-')) {
          // Position autocomplete above the input container
          if (containerRef.current) {
            const containerRect = containerRef.current.getBoundingClientRect();

            // Position above the input area (dropdown height ~250px, add margin)
            setCommandPosition({
              top: Math.max(10, containerRect.top - 270), // Ensure at least 10px from top
              left: containerRect.left
            });
          }

          setShowCommands(true);
          setCommandType('agent');
          setCommandQuery(textAfterAt.replace('agent-', ''));
          setCommandStartIndex(lastAtIndex);
          setShowMentions(false);
          return;
        }

        // Regular file @mention
        setShowMentions(true);
        setMentionQuery(textAfterAt);
        setMentionStartIndex(lastAtIndex);
        setMentionPosition({ top: -310, left: 0 });
        setShowCommands(false);
        return;
      }
    }

    // No autocomplete triggers found
    setShowMentions(false);
    setMentionQuery('');
    setMentionStartIndex(-1);
    setShowCommands(false);
    setCommandQuery('');
    setCommandStartIndex(-1);
  }, []);

  // Handle mention selection
  const handleMentionSelect = useCallback(
    (mention: Mention) => {
      // Replace @query with mention
      const beforeMention = message.slice(0, mentionStartIndex);
      const afterMention = message.slice(getSelectionStart() || mentionStartIndex);

      // Remove the @query text and add a placeholder marker
      setMessage(beforeMention + afterMention);

      // Add mention as attachment
      setAttachments((prev) => [
        ...prev,
        {
          type: 'mention',
          name: mention.displayName,
          content: mention.path,
          path: mention.path,
          subType: mention.type, // Preserve whether it's a file, folder, or symbol
        },
      ]);

      setShowMentions(false);
      setMentionQuery('');
      setMentionStartIndex(-1);

      // Focus back on textarea
      textareaRef.current?.focus();
    },
    [message, mentionStartIndex]
  );

  // Handle command/skill/agent selection
  const handleCommandSelect = useCallback(
    async (item: any) => {
      const currentSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
      const projectPath = currentSession?.worktreePath;
      const itemType = item.itemType || commandType;

      // Detect whether the autocomplete was opened by typing "/" (inline mode)
      // or by clicking the slash button (popover mode). In inline mode, a "/"
      // exists at commandStartIndex and needs to be replaced. In popover mode,
      // there's no "/" in the text — we insert fresh at the cursor.
      const isInlineMode = message[commandStartIndex] === '/';

      if (itemType === 'codex') {
        // Switch to Codex model — messages route through Codex SDK in the same chat
        const { availableModels, setSelectedModel } = useSessionStore.getState();
        const defaultCodexModel = availableModels.find((model) => model.id.startsWith('codex:'))?.id || 'codex:gpt-5.4';
        setSelectedModel(sessionId, defaultCodexModel);
        if (isInlineMode) {
          const beforeCommand = message.slice(0, commandStartIndex);
          setMessage(beforeCommand.trim());
        }
        // In popover mode: codex just switches model, no text change
      } else if (itemType === 'gstack') {
        // GStack mode activation/deactivation — set the mode and clear the slash command from input
        const gstackId = item.gstackId || null;
        setGStackMode(sessionId, gstackId as import('../../../shared/types').GStackMode | null);
        if (isInlineMode) {
          const beforeCommand = message.slice(0, commandStartIndex);
          setMessage(beforeCommand.trim());
        }
        // In popover mode: mode activation only, no text change
      } else if (itemType === 'command') {
        // Load command content and replace the /command with it
        try {
          const content = await window.electronAPI.extensions.getCommand(item.name, projectPath);
          if (content) {
            // Remove leading comment if present
            const lines = content.split('\n');
            const cleanContent = lines.filter((l: string) => !l.trim().startsWith('<!--')).join('\n').trim();

            if (isInlineMode) {
              // Replace /command with the command content, preserving text before and after
              const beforeCommand = message.slice(0, commandStartIndex);
              const afterCommand = message.slice(commandStartIndex + item.name.length + 1);
              setMessage(beforeCommand + cleanContent + (afterCommand ? ' ' + afterCommand : ''));
            } else {
              // Popover mode: insert command content at cursor
              const before = message.slice(0, commandStartIndex);
              const after = message.slice(commandStartIndex);
              setMessage(before + cleanContent + (after ? ' ' + after : ''));
            }
          }
        } catch (err) {
          console.error('[InputArea] Error loading command:', err);
        }
      } else if (itemType === 'skill' || itemType === 'claude-code') {
        // Skills and Claude Code builtins: insert /name at position
        if (isInlineMode) {
          const before = message.slice(0, commandStartIndex);
          const after = message.slice(getSelectionStart() || commandStartIndex);
          setMessage(before + `/${item.name}` + after);
        } else {
          // Popover mode: insert /name at cursor
          const before = message.slice(0, commandStartIndex);
          const after = message.slice(commandStartIndex);
          setMessage(before + `/${item.name} ` + after);
        }
      } else if (itemType === 'agent') {
        // Replace @agent-name with just the agent mention
        if (isInlineMode) {
          const before = message.slice(0, commandStartIndex);
          const after = message.slice(getSelectionStart() || commandStartIndex);
          setMessage(before + `@agent-${item.name}` + after);
        } else {
          const before = message.slice(0, commandStartIndex);
          const after = message.slice(commandStartIndex);
          setMessage(before + `@agent-${item.name} ` + after);
        }
      }

      setShowCommands(false);
      setCommandQuery('');
      setCommandStartIndex(-1);
      textareaRef.current?.focus();
    },
    [message, commandStartIndex, commandType, sessionId, setGStackMode]
  );

  // Save message to history
  const saveToHistory = useCallback((msg: string) => {
    if (!msg.trim()) return;

    setMessageHistory(prev => {
      // Don't add duplicates of the last entry
      if (prev.length > 0 && prev[0] === msg) return prev;

      // Add to front, limit to 50 entries
      const newHistory = [msg, ...prev.filter(h => h !== msg)].slice(0, 50);

      // Persist to localStorage
      try {
        localStorage.setItem(`grep-history-${sessionId}`, JSON.stringify(newHistory));
      } catch {
        // Ignore storage errors
      }

      return newHistory;
    });
  }, [sessionId]);

  // Select a history item
  const selectHistoryItem = useCallback((item: string) => {
    setMessage(item);
    setShowHistory(false);
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!message.trim() && attachments.length === 0) return;
    if (disabled) return;

    // Intercept /btw — ephemeral side question (not added to history)
    const trimmed = message.trim();
    if (/^\/btw\s+/i.test(trimmed)) {
      const question = trimmed.replace(/^\/btw\s+/i, '').trim();
      if (question) {
        setMessage('');
        await askBtw(sessionId, question);
        return;
      }
    }

    // If waiting for plan approval, treat input as plan feedback
    if (pendingPlanApproval && trimmed) {
      setMessage('');
      setAttachments([]);
      await rejectPlan(sessionId, trimmed);
      return;
    }

    // Note: We don't block on isSending - the store handles queueing if already streaming

    // Save to history before sending
    saveToHistory(message.trim());

    // Deactivate audio mode when typing manually
    setAudioMode(sessionId, false);

    // Build message with file context
    let fullMessage = message.trim();

    // Add file mentions to the message
    const fileMentions = attachments.filter((a) => a.type === 'mention');
    if (fileMentions.length > 0) {
      const fileContext = fileMentions
        .map((m) => `@${m.name}`)
        .join(', ');
      if (fullMessage) {
        fullMessage = `[Files: ${fileContext}]\n\n${fullMessage}`;
      } else {
        fullMessage = `Looking at: ${fileContext}`;
      }
    }

    const otherAttachments = attachments.filter((a) => a.type !== 'mention');
    console.log('[InputArea] Submitting with attachments:', otherAttachments.length);
    otherAttachments.forEach((a, i) => {
      console.log(`[InputArea] Attachment ${i}: type=${a.type}, name=${a.name}, content length=${a.content?.length || 0}`);
    });

    // Capture attachments before clearing state
    const attachmentsToSend = otherAttachments.length > 0 ? [...otherAttachments] : undefined;

    setMessage('');
    setAttachments([]);

    await sendMessage(sessionId, fullMessage, attachmentsToSend);
  };

  const handleStopStreaming = useCallback(() => {
    if (isSending) {
      // Use store's cancelStream to preserve partial content
      useSessionStore.getState().cancelStream(sessionId);
    }
  }, [isSending, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Command autocomplete keyboard control — all via ref, no window listeners
    if (showCommands && commandAutocompleteRef.current) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          commandAutocompleteRef.current.moveSelection('down');
          return;
        case 'ArrowUp':
          e.preventDefault();
          commandAutocompleteRef.current.moveSelection('up');
          return;
        case 'Tab':
        case 'Enter':
          e.preventDefault();
          commandAutocompleteRef.current.selectCurrent();
          return;
        case 'Escape':
          e.preventDefault();
          commandAutocompleteRef.current.dismiss();
          return;
      }
    }

    // Mention autocomplete — still uses its own handler for arrows/enter
    if (showMentions && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      return;
    }

    // Handle history navigation
    if (showHistory && messageHistory.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHistoryIndex(prev => Math.min(prev + 1, messageHistory.length - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHistoryIndex(prev => {
          if (prev <= 0) {
            setShowHistory(false);
            return -1;
          }
          return prev - 1;
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (historyIndex >= 0 && historyIndex < messageHistory.length) {
          selectHistoryItem(messageHistory[historyIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowHistory(false);
        setHistoryIndex(-1);
        return;
      }
    }

    // ArrowUp at start of input or empty input shows history
    if (e.key === 'ArrowUp' && messageHistory.length > 0) {
      const textarea = textareaRef.current;
      const cursorAtStart = !textarea || textarea.selectionStart === 0;
      const inputEmpty = !message.trim();

      if (cursorAtStart || inputEmpty) {
        e.preventDefault();
        setShowHistory(true);
        setHistoryIndex(0);
        return;
      }
    }

    // Shift+Tab to cycle permission modes
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cyclePermissionMode(sessionId);
      return;
    }

    // Option+Enter: Create conversation fork and send message to fork
    if (e.key === 'Enter' && e.altKey && !e.shiftKey) {
      e.preventDefault();

      const trimmedMessage = message.trim();
      if (!trimmedMessage) return; // Don't fork on empty input

      // Create fork BEFORE sending message
      useSessionStore.getState().createForkFromCurrent(trimmedMessage);

      // Clear input (message already sent to fork)
      setMessage('');
      setAttachments([]);
      return;
    }

    // Cmd+[: Previous fork tab
    if (e.key === '[' && e.metaKey) {
      e.preventDefault();
      useSessionStore.getState().cycleForkTabs('prev');
      return;
    }

    // Cmd+]: Next fork tab
    if (e.key === ']' && e.metaKey) {
      e.preventDefault();
      useSessionStore.getState().cycleForkTabs('next');
      return;
    }

    // Cmd+T: New fresh tab in same session group (NOT a fork — Option+Enter forks with transcript)
    if (e.key === 't' && e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const state = useSessionStore.getState();
      const currentSession = state.sessions.find(s => s.id === sessionId);
      if (currentSession?.sshConfig) {
        // Find root of fork group
        let rootId = sessionId;
        let walk: typeof currentSession | undefined = currentSession;
        while (walk?.parentSessionId) {
          rootId = walk.parentSessionId;
          walk = state.sessions.find(s => s.id === rootId);
        }
        const root = state.sessions.find(s => s.id === rootId);

        // Strip worktreeScript — reuse existing directory, don't re-run setup
        const { worktreeScript: _, ...cleanConfig } = currentSession.sshConfig as any;
        window.electronAPI.ssh.createSession({
          name: `${(root || currentSession).name} (new)`,
          sshConfig: { ...cleanConfig, syncSettings: false },
        }).then(async (newSession) => {
          if (!newSession) return;
          // Add as sibling tab in the fork group
          await window.electronAPI.sessions.update(newSession.id, { parentSessionId: rootId, isRoot: false } as any);
          if (root) {
            const children = [...(root.childSessionIds || [])];
            if (!children.includes(newSession.id)) {
              children.push(newSession.id);
              await window.electronAPI.sessions.update(rootId, { childSessionIds: children, isRoot: true } as any);
            }
          }
          state.loadSessions();
          state.setActiveSession(newSession.id);
        }).catch(err => console.error('[InputArea] Cmd+T new tab failed:', err));
      }
      return;
    }

    // Cmd+S: Open new session dialog
    if (e.key === 's' && e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      useUIStore.getState().openNewSessionDialog();
      return;
    }

    // Cmd+F: Let system handle (find in editor/page) — don't intercept

    // Cmd+Enter: Force send — interrupt current stream and send immediately
    if (e.key === 'Enter' && e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const trimmedMessage = message.trim();
      if (!trimmedMessage && attachments.length === 0) return;
      if (isSending) {
        // Interrupt and send
        const { interruptAndSend } = useSessionStore.getState();
        setMessage('');
        setAttachments([]);
        interruptAndSend(sessionId, trimmedMessage, attachments);
      } else {
        handleSubmit();
      }
      return;
    }

    // Regular Enter (without Alt): Send message (queues if streaming)
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit();
    }

    if (e.key === 'Escape') {
      // Close autocompletes first
      if (showMentions) {
        setShowMentions(false);
        return;
      }
      if (showCommands) {
        setShowCommands(false);
        return;
      }

      // Double-escape to stop streaming
      if (isSending) {
        // Clear any existing timeout
        if (escapeTimeout) {
          clearTimeout(escapeTimeout);
        }

        const newCount = escapeKeyCount + 1;
        setEscapeKeyCount(newCount);

        if (newCount >= 2) {
          // Stop streaming
          handleStopStreaming();
          setEscapeKeyCount(0);
          setEscapeTimeout(null);
          setShowEscapeWarning(false);
        } else {
          // Show warning on first press
          setShowEscapeWarning(true);

          // Set timeout to reset counter and hide warning
          const timeout = setTimeout(() => {
            setEscapeKeyCount(0);
            setEscapeTimeout(null);
            setShowEscapeWarning(false);
          }, 500); // 500ms window for double-escape
          setEscapeTimeout(timeout);
        }
      }
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) {
      console.log('[InputArea] No clipboardData available');
      return;
    }

    const items = clipboardData.items;
    const files = clipboardData.files;

    console.log('[InputArea] Paste event - items:', items?.length || 0, 'files:', files?.length || 0);
    console.log('[InputArea] Available types:', clipboardData.types.join(', '));

    // Try files first (more reliable for some browsers)
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log('[InputArea] File from clipboardData.files:', file.name, file.type, file.size);
        if (file.type.startsWith('image/')) {
          e.preventDefault();
          await processImageFile(file);
        }
      }
    }

    // Also check items (DataTransferItemList)
    if (items) {
      const itemsArray = Array.from(items);
      for (const item of itemsArray) {
        console.log('[InputArea] Clipboard item - type:', item.type, 'kind:', item.kind);

        // Check for image types (including variations)
        const isImage = item.type.startsWith('image/') ||
                       item.type === 'image' ||
                       (item.kind === 'file' && item.type.includes('image'));

        if (isImage && item.kind === 'file') {
          e.preventDefault();

          const file = item.getAsFile();
          if (!file) {
            console.log('[InputArea] Could not get file from clipboard item');
            continue;
          }

          // Check if we already processed this file from clipboardData.files
          // (some browsers provide the same file in both places)
          const alreadyProcessed = attachments.some(a =>
            a.type === 'image' && a.name.includes(`${file.size}`)
          );
          if (!alreadyProcessed) {
            await processImageFile(file);
          }
        }
      }
    }

    async function processImageFile(file: File) {
      console.log('[InputArea] Processing image file:', file.name, file.type, file.size);

      return new Promise<void>((resolve) => {
        const reader = new FileReader();

        reader.onload = () => {
          const base64 = reader.result as string;
          console.log('[InputArea] FileReader completed, result length:', base64?.length || 0);

          // Extract just the base64 data (remove data:image/xxx;base64, prefix)
          const base64Data = base64.split(',')[1] || base64;
          console.log('[InputArea] Base64 data extracted, length:', base64Data.length);

          const imageAttachment: Attachment = {
            type: 'image',
            name: `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
            content: base64Data,
          };

          setAttachments(prev => {
            console.log('[InputArea] Adding attachment to state. Current count:', prev.length);
            return [...prev, imageAttachment];
          });
          console.log('[InputArea] Image pasted and attached:', imageAttachment.name, 'content length:', base64Data.length);
          resolve();
        };

        reader.onerror = (error) => {
          console.error('[InputArea] FileReader error:', error);
          resolve();
        };

        reader.readAsDataURL(file);
      });
    }
  };

  // Get inspector state for this session
  const inspectorActive = sessionInspectorActive[sessionId] || false;

  const handleInspectElement = () => {
    // Toggle inspector - if already active, turn it off
    if (inspectorActive) {
      setSessionInspectorActive(sessionId, false);
    } else {
      setSessionInspectorActive(sessionId, true);
      toggleBrowserPanel(); // Open browser panel if not already open
    }
  };

  const handleSlashButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Open the command autocomplete anchored above the input container — same
    // position the inline "/" trigger uses, so the popover gets full width and
    // doesn't collide with the viewport edge.
    e.preventDefault();
    e.stopPropagation();

    if (containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      setCommandPosition({
        top: Math.max(10, containerRect.top - 270),
        left: containerRect.left,
      });
    }

    const elem = textareaRef.current;
    const cursorPos = elem?.selectionStart ?? message.length;

    setCommandType('command');
    setCommandQuery('');
    setCommandStartIndex(cursorPos);
    setShowCommands(true);
    setShowMentions(false);
  };

  const handleAtButtonClick = () => {
    // Insert @ at cursor position
    const elem = textareaRef.current;
    if (!elem) return;

    const start = elem.selectionStart ?? 0;
    const end = elem.selectionEnd ?? 0;
    const newValue = message.slice(0, start) + '@' + message.slice(end);
    setMessage(newValue);

    // Trigger the mention autocomplete
    setTimeout(() => {
      elem.selectionStart = start + 1;
      elem.selectionEnd = start + 1;
      elem.focus();

      setShowMentions(true);
      setMentionQuery('');
      setMentionStartIndex(start);
      setMentionPosition({ top: -310, left: 0 });
    }, 0);
  };

  // Auto-resize textarea
  useEffect(() => {
    const elem = textareaRef.current;
    if (elem) {
      elem.style.height = 'auto';
      elem.style.height = `${Math.min(elem.scrollHeight, 200)}px`;
    }
  }, [message]);

  // Voice mode hotkeys: DISABLED
  // CMD shortcuts were causing accidental voice mode triggers
  // Users should click the microphone button to toggle voice mode

  const getAttachmentIcon = (attachment: Attachment) => {
    switch (attachment.type) {
      case 'dom_element':
        return <Target size={12} className="text-blue-400" />;
      case 'image':
        return <Image size={12} className="text-green-400" />;
      case 'mention':
        // Use the actual subType instead of guessing from the name
        if (attachment.subType === 'folder') {
          return <Folder size={12} className="text-amber-400" />;
        } else if (attachment.subType === 'symbol') {
          return <Code size={12} className="text-purple-400" />;
        } else {
          return <File size={12} className="text-cyan-400" />;
        }
      default:
        return <FileCode size={12} className="text-purple-400" />;
    }
  };

  return (
    <>
      {/* Message Queue Panel */}
      <MessageQueuePanel sessionId={sessionId} />

      <div
        ref={containerRef}
        className="px-4 py-2 relative font-mono border-t border-claude-border"
      >
        {/* Compaction switch notice disabled — too disruptive */}

        {/* Mention Autocomplete */}
        {showMentions && (
        <MentionAutocomplete
          sessionId={sessionId}
          query={mentionQuery}
          position={mentionPosition}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentions(false)}
        />
      )}

      {/* Command/Skill/Agent Autocomplete */}
      {showCommands && (
        <CommandAutocomplete
          ref={commandAutocompleteRef}
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

      {/* Message History Dropdown */}
      {showHistory && messageHistory.length > 0 && (
        <div
          ref={historyDropdownRef}
          className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-claude-surface border border-claude-border shadow-lg z-50"
          style={{ borderRadius: 0 }}
        >
          <div className="px-3 py-1.5 text-xs text-claude-text-secondary font-mono border-b border-claude-border flex items-center justify-between">
            <span>HISTORY</span>
            <span className="text-[10px]">↑↓ navigate • Enter select • Esc close</span>
          </div>
          {messageHistory.map((item, index) => (
            <button
              key={index}
              onClick={() => selectHistoryItem(item)}
              className={`w-full text-left px-3 py-2 font-mono text-sm transition-colors ${
                index === historyIndex
                  ? 'bg-claude-accent/20 text-claude-text'
                  : 'text-claude-text-secondary hover:bg-claude-bg hover:text-claude-text'
              }`}
            >
              <div className="truncate">{item}</div>
            </button>
          ))}
        </div>
      )}

      {/* Attachments - brutalist badges */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((attachment, index) => (
            <div
              key={index}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs ${
                attachment.type === 'mention'
                  ? 'bg-claude-accent/20 border border-claude-accent/30'
                  : 'bg-claude-bg border border-claude-border'
              }`}
              style={{ borderRadius: 0 }}
            >
              {getAttachmentIcon(attachment)}
              <span className="truncate max-w-[180px] font-mono text-xs text-claude-text">
                {attachment.name}
              </span>
              <button
                onClick={() => removeAttachment(index)}
                className="hover:bg-claude-bg p-0.5 text-claude-text-secondary"
                style={{ borderRadius: 0 }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Escape warning message */}
      {showEscapeWarning && (
        <div className="mb-2 px-3 py-2 bg-amber-500/20 border border-amber-500/50 flex items-center gap-2 animate-fade-in">
          <span className="text-amber-200 text-xs font-mono uppercase" style={{ letterSpacing: '0.05em' }}>
            Press ESC again to stop Claudette
          </span>
        </div>
      )}

      {/* Voice Mode Status Bar - shown above input when voice mode is active */}
      {isVoiceModeActive && (
        <div className="mb-2 px-2 py-1.5 bg-claude-bg-secondary/50 border border-claude-border flex items-center gap-3 min-w-0">
          {/* Audio wave visualization - reacts to voice input */}
          <div className="flex items-center gap-[2px] h-5 flex-shrink-0">
            {[...Array(12)].map((_, i) => {
              const isAgentTalking = voiceState?.isSpeaking;
              const audioLevel = voiceState?.audioLevel || 0;
              const phase = Math.sin(waveTime + i * 0.5);
              const dynamicScale = isAgentTalking
                ? 0.6 + phase * 0.4
                : audioLevel > 0.05
                  ? 0.3 + audioLevel * 0.7 * (0.8 + Math.abs(phase) * 0.2)
                  : 0.25 + Math.abs(phase) * 0.15;
              return (
                <div
                  key={i}
                  className={`w-[2px] rounded-full transition-all duration-75 ${
                    isAgentTalking ? 'bg-claude-accent' : 'bg-green-400'
                  }`}
                  style={{
                    height: '14px',
                    transform: `scaleY(${dynamicScale})`,
                    opacity: isAgentTalking ? 1 : (audioLevel > 0.05 ? 0.8 + audioLevel * 0.2 : 0.5 + Math.abs(phase) * 0.2),
                  }}
                />
              );
            })}
          </div>

          {/* Status text - shows agent response or listening state, scrolls to end */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {voiceState?.agentResponse ? (
              <div
                className="overflow-x-auto hide-scrollbar"
                ref={(el) => { if (el) el.scrollLeft = el.scrollWidth; }}
              >
                <span className={`font-mono text-sm whitespace-nowrap inline-block ${
                  voiceState?.isSpeaking ? 'grep-speaking-shimmer' : 'text-claude-text'
                }`}>
                  {voiceState.agentResponse}
                </span>
              </div>
            ) : voiceState?.isSpeaking ? (
              <span className="font-mono text-sm text-claude-accent grep-speaking-shimmer block">
                Speaking...
              </span>
            ) : voiceState?.transcript ? (
              <div
                className="overflow-x-auto hide-scrollbar"
                ref={(el) => { if (el) el.scrollLeft = el.scrollWidth; }}
              >
                <span className="font-mono text-sm text-green-400 whitespace-nowrap inline-block">
                  {voiceState.transcript}
                </span>
              </div>
            ) : (
              <span className="font-mono text-sm text-green-400/70 block">
                Listening...
              </span>
            )}
          </div>

          {/* Shimmer effect and hide scrollbar */}
          <style>{`
            .hide-scrollbar {
              -ms-overflow-style: none;
              scrollbar-width: none;
            }
            .hide-scrollbar::-webkit-scrollbar {
              display: none;
            }
            @keyframes grepShimmer {
              0% { background-position: -200% center; }
              100% { background-position: 200% center; }
            }
            .grep-speaking-shimmer {
              background: linear-gradient(90deg, #8B5CF6 0%, #A78BFA 25%, #C4B5FD 50%, #A78BFA 75%, #8B5CF6 100%);
              background-size: 200% auto;
              background-clip: text;
              -webkit-background-clip: text;
              color: transparent;
              animation: grepShimmer 2s linear infinite;
            }
          `}</style>

          {/* Status indicator */}
          <div className="flex items-center gap-1.5 text-xs font-mono flex-shrink-0">
            <span className={`h-2 w-2 rounded-full ${
              voiceState?.isSpeaking ? 'bg-claude-accent' : 'bg-green-400'
            }`} />
            <span className={voiceState?.isSpeaking ? 'text-claude-accent' : 'text-green-400'}>
              {voiceState?.isSpeaking ? 'SPEAKING' : 'LISTENING'}
            </span>
          </div>
        </div>
      )}

      {/* Input row - CLI style - always visible */}
      <div className="flex flex-col gap-1">
        {/* Prompt + Input */}
        <div className="flex items-center gap-2">
          {/* Secure Input */}
          <div className="flex-1 relative min-w-0">
            <SecureInput
              ref={textareaRef}
              value={message}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={disabled ? 'session inactive...' : isVoiceModeActive ? 'add context or type message...' : isSending ? `type to queue message${hasQueuedMessages ? ` (${queuedMessages.length} queued)` : ''}...` : 'type here... (@ to mention, paste images)'}
              disabled={disabled}
              className={`w-full py-0 resize-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed min-h-[24px] max-h-[200px] font-mono bg-transparent text-base text-claude-text placeholder:text-claude-text-secondary leading-6 caret-claude-accent ${
                useAudioStore.getState().recordingStates[sessionId]?.isRecording ? 'border-l-2 border-red-500 pl-2' : ''
              }`}
              rows={1}
            />
          </div>
        </div>

        {/* Unified toolbar: mode/effort/model left, icons right */}
        <div className="flex items-center gap-2 text-xs text-claude-text-secondary font-mono" style={{ letterSpacing: '0.03em' }}>
          {/* Left: mode */}
          <button
            onClick={() => cyclePermissionMode(sessionId)}
            disabled={disabled}
            className={`hover:opacity-80 transition-opacity disabled:opacity-40 text-[10px] -order-3 ${modeConfig.color}`}
            title={permissionModeTitle}
          >
            {modeConfig.label}
          </button>
          {/* GStack skill launcher */}
          <div className="relative ml-auto">
            <button
              onClick={() => setShowGStack(!showGStack)}
              disabled={disabled}
              className={`p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-0.5 ${
                activeGStackMode ? 'text-claude-text' : showGStack ? 'text-claude-text' : 'text-claude-text-secondary hover:text-claude-accent'
              }`}
              style={{ borderRadius: 0 }}
              title="GStack Skills"
            >
              <span className="text-xs font-bold font-mono leading-none" style={{ fontSize: '13px' }}>G</span>
              {activeGStackMode && GSTACK_MODE_META[activeGStackMode] && (
                <span
                  className="text-[8px] font-bold font-mono px-0.5 rounded-sm"
                  style={{ backgroundColor: GSTACK_MODE_META[activeGStackMode].color, color: '#000' }}
                >
                  {GSTACK_MODE_META[activeGStackMode].shortName}
                </span>
              )}
            </button>
            {showGStack && (
              <GStackLauncher
                sessionId={sessionId}
                onClose={() => setShowGStack(false)}
              />
            )}
          </div>
          <button
            onClick={handleAtButtonClick}
            disabled={disabled}
            className="p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed text-claude-text-secondary hover:text-claude-accent"
            style={{ borderRadius: 0 }}
            title="@ mention file"
          >
            <AtSign size={14} />
          </button>
          <button
            onClick={handleSlashButtonClick}
            disabled={disabled}
            className="p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed text-claude-text-secondary hover:text-claude-accent"
            style={{ borderRadius: 0 }}
            title="/ slash commands (Monitor, Loop, etc.)"
          >
            <Slash size={14} />
          </button>
          <button
            onClick={handleInspectElement}
            disabled={disabled}
            className={`p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed ${
              inspectorActive ? 'text-claude-accent' : 'text-claude-text-secondary'
            }`}
            style={{ borderRadius: 0 }}
            title={inspectorActive ? 'Cancel inspector (click again)' : 'Inspect element'}
          >
            <Target size={14} />
          </button>
          <button
            onClick={() => {
              const { sendMessage } = useSessionStore.getState();
              sendMessage(sessionId, 'continue');
            }}
            disabled={disabled}
            className="p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed text-claude-text-secondary hover:text-claude-accent"
            style={{ borderRadius: 0 }}
            title="Ping for update (sends 'continue')"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => {
              if (remoteControl) {
                useSessionStore.getState().stopRemoteControl(sessionId);
              } else {
                useSessionStore.getState().startRemoteControl(sessionId);
              }
            }}
            disabled={disabled}
            className={`p-1 transition-colors hover:bg-claude-bg disabled:opacity-40 disabled:cursor-not-allowed ${
              remoteControl ? 'text-green-400' : 'text-claude-text-secondary hover:text-claude-accent'
            }`}
            style={{ borderRadius: 0 }}
            title={remoteControl ? 'Remote control active — click to stop' : 'Control from phone'}
          >
            <Smartphone size={14} />
          </button>
          <button
            onClick={async () => {
              try {
                // Send /compact to summarise and compress the conversation context
                await window.electronAPI.claude.injectMessage(sessionId, '/compact');
              } catch (err) {
                console.error('[InputArea] Compact failed:', err);
              }
            }}
            disabled={disabled || isSending}
            className="p-1 transition-colors hover:bg-claude-bg text-claude-text-secondary hover:text-amber-400 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderRadius: 0 }}
            title="Summarize & compact context"
          >
            <Eraser size={14} />
          </button>
          {isSending && (
            <button
              onClick={handleStopStreaming}
              className="p-1 transition-colors hover:bg-claude-bg text-red-400 hover:text-red-300 animate-pulse"
              style={{ borderRadius: 0 }}
              title="Stop (ESC ESC)"
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <VoiceModeErrorBoundary>
            <MicrophoneButton
              ref={voiceModeRef}
              sessionId={sessionId}
              onInterimTranscript={(text) => {
                // Stream real-time transcript into the input box
                setMessage(text);
              }}
              onTranscriptionComplete={async (text) => {
                console.log('[InputArea] onTranscriptionComplete called with:', text, 'voiceModeActive:', isVoiceModeActive);

                // In voice mode (ElevenLabs), send directly without trigger word
                // This enables the hybrid flow where transcripts go straight to Build
                if (isVoiceModeActive && !disabled && !isSending && text.trim()) {
                  console.log('[InputArea] Voice mode active - sending directly to Build');

                  // Activate audio mode for auto-play TTS on response
                  setAudioMode(sessionId, true);

                  // Clear input and send
                  setMessage('');

                  // Build message with file context if there are attachments
                  let messageToSend = text.trim();
                  const fileMentions = attachments.filter((a) => a.type === 'mention');
                  if (fileMentions.length > 0) {
                    const fileContext = fileMentions.map((m) => `@${m.name}`).join(', ');
                  messageToSend = `[Files: ${fileContext}]\n\n${messageToSend}`;
                }

                const otherAttachments = attachments.filter((a) => a.type !== 'mention');
                setAttachments([]);

                await sendMessage(sessionId, messageToSend, otherAttachments.length > 0 ? otherAttachments : undefined);
                return;
              }

              // Not in voice mode - use trigger word detection
              // Check if the transcription ends with the trigger word (configurable in settings)
              const escapedTrigger = triggerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const triggerPattern = new RegExp(`\\b${escapedTrigger}\\s*[.!?]?\\s*$`, 'i');

              const hasTrigger = triggerPattern.test(text);
              console.log('[InputArea] Trigger detection:', {
                triggerWord,
                escapedTrigger,
                text,
                hasTrigger,
                disabled,
                isSending,
              });

              if (hasTrigger && !disabled && !isSending) {
                // Remove the trigger word from the message
                const cleanedText = text
                  .replace(triggerPattern, '')
                  .trim();

                if (!cleanedText) {
                  setMessage('');
                  return;
                }

                // Activate audio mode for auto-play TTS on response
                setAudioMode(sessionId, true);

                // Clear input and send
                setMessage('');

                // Build message with file context if there are attachments
                let messageToSend = cleanedText;
                const fileMentions = attachments.filter((a) => a.type === 'mention');
                if (fileMentions.length > 0) {
                  const fileContext = fileMentions.map((m) => `@${m.name}`).join(', ');
                  messageToSend = `[Files: ${fileContext}]\n\n${messageToSend}`;
                }

                const otherAttachments = attachments.filter((a) => a.type !== 'mention');
                setAttachments([]);

                await sendMessage(sessionId, messageToSend, otherAttachments.length > 0 ? otherAttachments : undefined);
              } else {
                // No trigger word - keep the text in input for editing/review
                // But still enable audio mode since user is using voice
                setAudioMode(sessionId, true);
                setMessage(text);
                textareaRef.current?.focus();
              }
            }}
            disabled={disabled}
          />
          </VoiceModeErrorBoundary>

        {/* Effort level selector */}
        <div className="relative -order-2" ref={effortDropdownRef}>
          <button
            onClick={() => setShowEffortDropdown(!showEffortDropdown)}
            disabled={disabled}
            className={`flex items-center gap-1 hover:opacity-80 transition-opacity disabled:opacity-40 ${effortConfig.color}`}
            title={`${effortConfig.description} (click to change)`}
          >
            <Brain size={10} />
            <span>{effortConfig.label}</span>
          </button>
          {showEffortDropdown && (
            <div className="absolute bottom-full left-0 mb-1 bg-claude-surface border border-claude-border shadow-lg z-50 min-w-48">
              {(['low', 'medium', 'high', 'max'] as EffortLevel[]).map((level) => {
                const config = EFFORT_LEVEL_CONFIG[level];
                const isOpus = currentModel.includes('opus');
                const isDisabled = config.opusOnly && !isOpus;

                return (
                  <button
                    key={level}
                    onClick={() => {
                      if (!isDisabled) {
                        setThinkingMode(sessionId, level);
                        setShowEffortDropdown(false);
                      }
                    }}
                    disabled={isDisabled}
                    className={`w-full text-left px-3 py-2 hover:bg-claude-bg transition-colors ${
                      level === migratedThinkingMode ? 'bg-claude-bg text-claude-accent' : 'text-claude-text'
                    } ${isDisabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <div className="font-mono text-xs">{config.label}</div>
                    <div className="text-[10px] text-claude-text-secondary">
                      {config.description}
                      {isDisabled && ' (Opus only)'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {/* Model selector - always visible */}
        <div className="relative -order-1" ref={modelDropdownRef}>
          <button
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            disabled={disabled}
            className="text-claude-text-secondary hover:text-claude-text transition-colors disabled:opacity-40"
            title={`${currentModelInfo.description} (click to change)`}
          >
            {isStreamingProp && systemInfo ? (systemInfo.model || currentModelInfo.name) : currentModelInfo.name}
          </button>
          {showModelDropdown && (() => {
            // Two-level menu: Harness → Models

            const groups: Record<string, typeof availableModels> = {};
            const groupOrder = ['claude', 'cursor', 'codex', 'opencode', 'custom'];
            const groupLabels: Record<string, string> = {
              claude: 'Claude',
              cursor: 'Cursor',
              codex: 'Codex',
              opencode: 'DeepSeek',
              custom: 'Custom',
            };

            for (const model of availableModels) {
              let group = 'claude';
              if (model.id.startsWith('codex:')) group = 'codex';
              else if (model.id.startsWith('cursor:')) group = 'cursor';
              else if (model.id.startsWith('opencode:')) group = 'opencode';
              else if (model.id.startsWith('custom:')) group = 'custom';
              if (!groups[group]) groups[group] = [];
              groups[group].push(model);
            }

            // Recently used: last 3
            const recentIds: string[] = JSON.parse(localStorage.getItem('grep-recent-models') || '[]').slice(0, 3);
            const recentModels = recentIds.map(id => availableModels.find(m => m.id === id)).filter(Boolean) as typeof availableModels;

            const selectModel = (modelId: string) => {
              setSelectedModel(sessionId, modelId);
              setShowModelDropdown(false);
              const recent = JSON.parse(localStorage.getItem('grep-recent-models') || '[]') as string[];
              const updated = [modelId, ...recent.filter(id => id !== modelId)].slice(0, 5);
              localStorage.setItem('grep-recent-models', JSON.stringify(updated));
            };

            // Current harness for highlight
            let currentHarness = 'claude';
            if (currentModel.startsWith('codex:')) currentHarness = 'codex';
            else if (currentModel.startsWith('cursor:')) currentHarness = 'cursor';
            else if (currentModel.startsWith('opencode:')) currentHarness = 'opencode';
            else if (currentModel.startsWith('custom:')) currentHarness = 'custom';

            const activeHarness = hoverHarness || currentHarness;
            const activeModels = groups[activeHarness] || [];

            return (
              <div className="absolute bottom-full left-0 mb-1 flex z-50">
                {/* Level 1: Harness list */}
                <div className="bg-claude-surface border border-claude-border shadow-lg min-w-32">
                  {/* Recently used quick-picks */}
                  {recentModels.length > 0 && (
                    <>
                      <div className="px-3 py-1 text-[8px] font-bold text-claude-text-secondary uppercase tracking-wider bg-claude-bg/50">
                        Recent
                      </div>
                      {recentModels.map(m => (
                        <button
                          key={`recent-${m.id}`}
                          onClick={() => selectModel(m.id)}
                          className={`w-full text-left px-3 py-1 hover:bg-claude-bg text-[10px] font-mono ${
                            m.id === currentModel ? 'text-claude-accent' : 'text-claude-text-secondary'
                          }`}
                        >
                          {m.name}
                        </button>
                      ))}
                      <div className="border-b border-claude-border/30 my-0.5" />
                    </>
                  )}
                  {/* Harness options */}
                  {groupOrder.map(key => {
                    const models = groups[key];
                    if (!models || models.length === 0) return null;
                    const isActive = activeHarness === key;
                    const hasCurrentModel = models.some(m => m.id === currentModel);
                    return (
                      <button
                        key={key}
                        onMouseEnter={() => setHoverHarness(key)}
                        onClick={() => setHoverHarness(key)}
                        className={`w-full text-left px-3 py-1.5 flex items-center justify-between transition-colors ${
                          isActive ? 'bg-claude-bg text-claude-text' : 'text-claude-text-secondary hover:bg-claude-bg/50'
                        }`}
                      >
                        <span className="font-mono text-xs">
                          {hasCurrentModel && <span className="text-claude-accent mr-1">●</span>}
                          {groupLabels[key]}
                        </span>
                        <span className="text-[10px] text-claude-text-secondary">›</span>
                      </button>
                    );
                  })}
                </div>
                {/* Level 2: Models for selected harness */}
                <div className="bg-claude-surface border border-claude-border border-l-0 shadow-lg min-w-44 max-h-64 overflow-y-auto">
                  <div className="px-3 py-1 text-[8px] font-bold text-claude-text-secondary uppercase tracking-wider bg-claude-bg/50 sticky top-0">
                    {groupLabels[activeHarness]} Models
                  </div>
                  {activeModels.map(model => (
                    <button
                      key={model.id}
                      onClick={() => selectModel(model.id)}
                      className={`w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors ${
                        model.id === currentModel ? 'bg-claude-bg text-claude-accent' : 'text-claude-text'
                      }`}
                    >
                      <div className="font-mono text-xs">{model.name.replace(/ \(Cursor\)| \(Codex\)/, '')}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
        {/* Context usage indicator — pushed to far right */}
        {contextUsage && (
          <div className="flex items-center gap-1.5" style={{ order: -1 }} title={`${contextUsage.inputTokens.toLocaleString()} / ${contextUsage.contextWindowSize.toLocaleString()} tokens (${contextUsage.percentage}%)`}>
            <div className="w-16 h-1.5 bg-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
              <div
                className={`h-full transition-all ${
                  contextUsage.percentage >= 75 ? 'bg-red-500' :
                  contextUsage.percentage >= 50 ? 'bg-amber-500' :
                  'bg-claude-accent'
                }`}
                style={{ width: `${Math.min(100, contextUsage.percentage)}%` }}
              />
            </div>
            <span className={`text-[9px] tabular-nums ${
              contextUsage.percentage >= 75 ? 'text-red-400' :
              contextUsage.percentage >= 50 ? 'text-amber-400' :
              'text-claude-text-secondary'
            }`}>
              {contextUsage.percentage}%
            </span>
          </div>
        )}
        </div>
      </div>
      </div>
    </>
  );
}
