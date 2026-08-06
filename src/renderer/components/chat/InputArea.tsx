import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { X, Image, FileCode, Target, File, Folder, Brain, Square, Code, Smartphone, RefreshCw, Paperclip, Workflow, MoreHorizontal } from 'lucide-react';
import { useSessionStore, type PermissionMode, type ThinkingMode, type EffortLevel, migrateThinkingMode, normalizePermissionModeForModel } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useAudioStore } from '../../stores/audio.store';
import MentionAutocomplete, { type Mention } from './MentionAutocomplete';
import CommandAutocomplete, { type CommandAutocompleteHandle } from './CommandAutocomplete';
import { MessageQueuePanel } from './MessageQueuePanel';
import SecureInput from './SecureInput';
import CompactionSwitchNotice from './CompactionSwitchNotice';
import { VoiceComposerControl } from './VoiceComposerControl';
import { AutoRouteBadge, formatHarnessModelLabel, inferHarnessFromModel } from './AutoRouteBadge';
import { GSTACK_MODE_META } from '../../../shared/types';
import { PARABLE_MODE_ID } from '../../../shared/config/parable';
import { getBrowserPartitionId } from '../../../shared/utils/browser-partition';
import { calculateVisibleToolbarActions } from '../../utils/toolbar-overflow';
import { APP_VOICE_SESSION_ID } from '../../utils/voice-session-directory';

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

type SlashCommandItem = {
  name: string;
  description: string;
  scope: string;
  itemType: string;
  gstackId?: string | null;
  cascadeEnabled?: boolean;
};

type ExtensionScanResult = {
  commands: SlashCommandItem[];
  skills: any[];
  agents: any[];
  gstackCommands: SlashCommandItem[];
};

const EXTENSION_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOOLBAR_ACTION_COUNT = 6;
const TOOLBAR_ACTION_WIDTH = 24;
const TOOLBAR_GAP = 8;
const extensionScanCache = new Map<string, {
  expiresAt: number;
  promise: Promise<ExtensionScanResult>;
}>();

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
        window.electronAPI.gstack.getModes().then(setSkills).catch((error) => {
          console.warn('[GStackLauncher] Failed to load modes:', error);
        });
      }
    }).catch((error) => {
      console.warn('[GStackLauncher] Failed to check installation:', error);
    });
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
  screenshot?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  subType?: 'file' | 'folder' | 'symbol'; // For mentions: preserves the original type
}

// Stable empty arrays to avoid reference changes when session data is missing
const EMPTY_QUEUE: never[] = [];
const EMPTY_MODELS: never[] = [];
const EMPTY_ATTACHMENTS: Attachment[] = [];
const composerTextDrafts = new Map<string, string>();
const composerAttachmentDrafts = new Map<string, Attachment[]>();
const PLAN_MODE_NUDGE_SUPPRESSED_KEY = 'grep-plan-mode-nudge-suppressed';
const SUBMITTED_INPUT_ECHO_SUPPRESS_MS = 60_000;
const MAX_PASTED_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  'csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'sql', 'sh', 'bash', 'zsh', 'env',
  'log', 'psv',
]);

function isPlanModeNudgeSuppressed(): boolean {
  try {
    return localStorage.getItem(PLAN_MODE_NUDGE_SUPPRESSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function suppressPlanModeNudge(): void {
  try {
    localStorage.setItem(PLAN_MODE_NUDGE_SUPPRESSED_KEY, 'true');
  } catch {
    // Ignore storage errors.
  }
}

function isSupportedTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  if (file.type === 'text/csv' || file.type === 'application/csv') return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return !!ext && TEXT_FILE_EXTENSIONS.has(ext);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1] || dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const MAX_DROPPED_FILE_BYTES = 25 * 1024 * 1024;

function shouldSuggestPlanModeNudge(
  text: string,
  attachments: Attachment[],
  currentModel: string,
  currentMode: PermissionMode,
  cascadeActive: boolean,
): boolean {
  if (currentModel === 'auto' || currentModel === PARABLE_MODE_ID || cascadeActive || currentMode === 'plan' || isPlanModeNudgeSuppressed()) return false;

  const trimmed = text.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  const hasVisualContext = attachments.some((attachment) => attachment.type === 'image' || attachment.type === 'dom_element');
  const broadScope = /\b(site|website|landing|homepage|hero|page|section|sections|overall|whole|entire|full|all|end[- ]to[- ]end|rewrite)\b/.test(lower);
  const planningIntent = /\b(plan|strategy|positioning|messaging|narrative|information architecture|content strategy|copy strategy|rewrite strategy|approach|direction)\b/.test(lower);
  const copyRewriteIntent = /\b(copy|rewrite|messaging|headline|tagline|value prop|value proposition|tone|voice|content|landing page|website)\b/.test(lower);
  const largeEnough = trimmed.length > 180;

  if (planningIntent && (broadScope || hasVisualContext || largeEnough)) return true;
  return copyRewriteIntent && broadScope && (hasVisualContext || trimmed.length > 120);
}

function InputArea({ sessionId, disabled, systemInfo, isStreaming: isStreamingProp }: InputAreaProps) {
  // Composer text is deliberately local. Putting keystrokes in the global UI
  // store invalidated every mounted panel/webview and could steal focus after
  // each character. The module cache preserves drafts across session-tab
  // mounts without broadcasting each keystroke through the whole app.
  const [message, setLocalMessage] = useState(() => composerTextDrafts.get(sessionId) || '');
  const setMessage = useCallback((next: React.SetStateAction<string>) => {
    setLocalMessage((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved) composerTextDrafts.set(sessionId, resolved);
      else composerTextDrafts.delete(sessionId);
      return resolved;
    });
  }, [sessionId]);
  useEffect(() => {
    setLocalMessage(composerTextDrafts.get(sessionId) || '');
  }, [sessionId]);
  const [, refreshAttachments] = useState(0);
  const attachments = composerAttachmentDrafts.get(sessionId) || EMPTY_ATTACHMENTS;
  const setAttachments = useCallback((next: React.SetStateAction<Attachment[]>) => {
    const current = composerAttachmentDrafts.get(sessionId) || EMPTY_ATTACHMENTS;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved.length > 0) composerAttachmentDrafts.set(sessionId, resolved);
    else composerAttachmentDrafts.delete(sessionId);
    refreshAttachments((revision) => revision + 1);
  }, [sessionId]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [escapeKeyCount, setEscapeKeyCount] = useState(0);
  const [escapeTimeout, setEscapeTimeout] = useState<NodeJS.Timeout | null>(null);
  const [showEscapeWarning, setShowEscapeWarning] = useState(false);
  const [showPlanModeNudge, setShowPlanModeNudge] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // GStack skill launcher
  const [showGStack, setShowGStack] = useState(false);
  const [visibleToolbarActionCount, setVisibleToolbarActionCount] = useState(TOOLBAR_ACTION_COUNT);
  const [showToolbarOverflow, setShowToolbarOverflow] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarPrimaryRef = useRef<HTMLDivElement>(null);
  const toolbarPinnedRef = useRef<HTMLDivElement>(null);
  const toolbarOverflowRef = useRef<HTMLDivElement>(null);

  // Message history state
  const [messageHistory, setMessageHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const commandAutocompleteRef = useRef<CommandAutocompleteHandle>(null);
  const blurFromBrowserEditRef = useRef(false);
  const submittedInputRef = useRef<{ texts: string[]; at: number } | null>(null);

  // Helper to safely get selection position
  const getSelectionStart = (): number | undefined => {
    return textareaRef.current?.selectionStart ?? undefined;
  };

  const rememberSubmittedInput = useCallback((...texts: Array<string | undefined>) => {
    const normalizedTexts = texts
      .map((text) => (text || '').trim())
      .filter((text, index, list) => text.length > 0 && list.indexOf(text) === index);
    submittedInputRef.current = normalizedTexts.length > 0
      ? { texts: normalizedTexts, at: Date.now() }
      : null;
  }, []);

  const suppressSubmittedInputEcho = useCallback((text: string, source: string) => {
    const submitted = submittedInputRef.current;
    const normalizedText = text.trim();
    if (!submitted || !normalizedText) return false;
    if (Date.now() - submitted.at > SUBMITTED_INPUT_ECHO_SUPPRESS_MS) return false;
    if (!submitted.texts.includes(normalizedText)) return false;
    console.warn(`[InputArea] Suppressing stale submitted input echo from ${source}`);
    return true;
  }, []);

  // Per-session data selectors — only re-render when THIS session's data changes
  const isStreamingState = useSessionStore(useCallback((s) => s.isStreaming[sessionId] || false, [sessionId]));
  const isProcessingQueueState = useSessionStore(useCallback((s) => s.isProcessingQueue[sessionId] || false, [sessionId]));
  const currentMode = useSessionStore(useCallback((s) => normalizePermissionModeForModel(
    s.selectedModel[sessionId] || 'auto',
    s.permissionMode[sessionId],
  ), [sessionId]));
  const contextUsage = useSessionStore(useCallback((s) => s.contextUsage[sessionId] || null, [sessionId]));
  const currentThinkingMode = useSessionStore(useCallback((s) => s.thinkingMode[sessionId] || 'thinking', [sessionId]));
  const currentHtmlMode = useSessionStore(useCallback((s) => s.htmlRenderMode[sessionId] || 'md', [sessionId]));
  const activeGStackMode = useSessionStore(useCallback((s) => s.gstackMode[sessionId] || null, [sessionId]));
  const cascadeActive = useSessionStore(useCallback((s) => Boolean(s.cascadeMode[sessionId]), [sessionId]));
  const queuedMessages = useSessionStore(useCallback((s) => s.messageQueue[sessionId] || EMPTY_QUEUE, [sessionId]));
  const currentModel = useSessionStore(useCallback((s) => s.selectedModel[sessionId] || 'auto', [sessionId]));
  const activeStreamModel = useSessionStore(useCallback((s) => s.activeStreamModel[sessionId], [sessionId]));
  const activeParableAgent = useSessionStore(useCallback((s) => {
    const monitors = s.monitorInstances[sessionId] || [];
    return [...monitors].reverse().find((monitor) => (
      monitor.active && monitor.kind === 'subagent' && /\bparable[-\w]*/i.test(monitor.description)
    ));
  }, [sessionId]));
  const autoRouteDecision = useSessionStore(useCallback((s) => s.autoRouteDecision[sessionId] || null, [sessionId]));
  const compactionSwitch = useSessionStore(useCallback((s) => s.compactionSwitch[sessionId] || null, [sessionId]));
  const availableModels = useSessionStore((s) => s.availableModels || EMPTY_MODELS);
  const fastMode = useSessionStore((s) => s.fastMode);
  const toggleFastMode = useSessionStore((s) => s.toggleFastMode);

  // Action selectors — stable references, never cause re-renders
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const interruptAndSend = useSessionStore((s) => s.interruptAndSend);
  const askBtw = useSessionStore((s) => s.askBtw);
  const remoteControl = useSessionStore(useCallback((s) => s.remoteControl[sessionId] || null, [sessionId]));
  const pendingPlanApproval = useSessionStore(useCallback((s) => s.pendingPlanApproval[sessionId] || null, [sessionId]));
  const rejectPlan = useSessionStore((s) => s.rejectPlan);
  const cyclePermissionMode = useSessionStore((s) => s.cyclePermissionMode);
  const setGStackMode = useSessionStore((s) => s.setGStackMode);
  const setCascadeMode = useSessionStore((s) => s.setCascadeMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const cycleThinkingMode = useSessionStore((s) => s.cycleThinkingMode);
  const setThinkingMode = useSessionStore((s) => s.setThinkingMode);
  const cycleHtmlRenderMode = useSessionStore((s) => s.cycleHtmlRenderMode);
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel);
  const dismissCompactionSwitch = useSessionStore((s) => s.dismissCompactionSwitch);
  const handoffCompactionModel = useSessionStore((s) => s.handoffCompactionModel);
  const restoreCompactionModel = useSessionStore((s) => s.restoreCompactionModel);
  const loadAvailableModels = useSessionStore((s) => s.loadAvailableModels);

  // UI store — fine-grained selectors
  const selectedElement = useUIStore((s) => s.selectedElement);
  const setSelectedElement = useUIStore((s) => s.setSelectedElement);
  const sessionInspectorActive = useUIStore((s) => s.sessionInspectorActive);
  const setSessionInspectorActive = useUIStore((s) => s.setSessionInspectorActive);

  // Audio store — fine-grained selectors
  const setAudioMode = useAudioStore((s) => s.setAudioMode);
  // Realtime voice is owned by the app and remains active while tabs change.
  const isVoiceModeActive = useAudioStore((s) => Boolean(s.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnected));
  const isVoiceModeConnecting = useAudioStore((s) => Boolean(s.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnecting));
  const isActiveComposer = useSessionStore(useCallback((s) => s.activeSessionId === sessionId, [sessionId]));
  const voiceComposerExpanded = isActiveComposer && (isVoiceModeActive || isVoiceModeConnecting);

  // Command/Skill/Agent autocomplete state
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandType, setCommandType] = useState<'command' | 'skill' | 'agent'>('command');
  const [commandPosition, setCommandPosition] = useState({ top: 0, left: 0 });
  const [commandStartIndex, setCommandStartIndex] = useState(-1);
  const [commands, setCommands] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);

  const modeConfig = PERMISSION_MODE_CONFIG[currentMode];
  const permissionModeTitle = `${modeConfig.description} (click to change)`;
  // Apply migration for legacy thinking mode values
  const migratedThinkingMode = migrateThinkingMode(currentThinkingMode);
  const effortConfig = EFFORT_LEVEL_CONFIG[migratedThinkingMode] || EFFORT_LEVEL_CONFIG['high'];

  const isSending = isStreamingState || isProcessingQueueState || (isStreamingProp ?? false);
  // Don't count messages as "queued" when they're being actively injected
  // into a live stream — they've already been sent to Claude via streamInput.
  const effectiveQueuedCount = (isProcessingQueueState && isStreamingState) ? 0 : queuedMessages.length;
  const hasQueuedMessages = effectiveQueuedCount > 0;
  const modeChangeDisabled = disabled || isSending || hasQueuedMessages;

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const primary = toolbarPrimaryRef.current;
    const pinned = toolbarPinnedRef.current;
    if (!toolbar || !primary || !pinned) return;

    let animationFrame = 0;
    const updateVisibleActions = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const nextCount = calculateVisibleToolbarActions({
          toolbarWidth: toolbar.clientWidth,
          primaryWidth: primary.scrollWidth,
          pinnedWidth: pinned.offsetWidth,
          actionCount: TOOLBAR_ACTION_COUNT,
          actionWidth: TOOLBAR_ACTION_WIDTH,
          gap: TOOLBAR_GAP,
        });

        setVisibleToolbarActionCount((current) => current === nextCount ? current : nextCount);
      });
    };

    updateVisibleActions();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateVisibleActions);
    resizeObserver?.observe(toolbar);
    resizeObserver?.observe(primary);
    resizeObserver?.observe(pinned);
    window.addEventListener('resize', updateVisibleActions);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateVisibleActions);
    };
  }, [isSending]);

  useEffect(() => {
    if (visibleToolbarActionCount === TOOLBAR_ACTION_COUNT) {
      setShowToolbarOverflow(false);
    }
  }, [visibleToolbarActionCount]);

  useEffect(() => {
    if (isSending || hasQueuedMessages) {
      setShowPlanModeNudge(false);
    }
  }, [isSending, hasQueuedMessages]);

  // Model selector state
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [hoverHarness, setHoverHarness] = useState<string | null>(null);
  const hoverHarnessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setHoverHarnessDebounced = useCallback((key: string) => {
    if (hoverHarnessTimer.current) clearTimeout(hoverHarnessTimer.current);
    hoverHarnessTimer.current = setTimeout(() => setHoverHarness(key), 120);
  }, []);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Effort level selector state
  const [showEffortDropdown, setShowEffortDropdown] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement>(null);

  // Get current model display name
  const currentModelInfo = useMemo(() => {
    const model = availableModels.find(m => m.id === currentModel);
    return model || { id: currentModel, name: currentModel.split('-').slice(1, 3).join(' ').toUpperCase(), description: '' };
  }, [availableModels, currentModel]);
  const isAutoRouteActive = Boolean(
    autoRouteDecision?.resolvedModel &&
    (currentModel === 'auto' || activeStreamModel === autoRouteDecision.resolvedModel),
  );
  const autoRouteModelInfo = useMemo(() => {
    if (!isAutoRouteActive || !autoRouteDecision?.resolvedModel) return undefined;
    return availableModels.find(m => m.id === autoRouteDecision.resolvedModel);
  }, [availableModels, autoRouteDecision?.resolvedModel, isAutoRouteActive]);
  const actualActiveModel = useMemo(() => {
    if (!isSending) return currentModel === 'auto' ? undefined : currentModel;
    if (activeStreamModel && activeStreamModel !== 'auto') return activeStreamModel;
    if (isAutoRouteActive && autoRouteDecision?.resolvedModel) return autoRouteDecision.resolvedModel;
    if (systemInfo?.model && systemInfo.model !== 'auto') return systemInfo.model;
    return currentModel === 'auto' ? undefined : currentModel;
  }, [activeStreamModel, autoRouteDecision?.resolvedModel, currentModel, isAutoRouteActive, isSending, systemInfo?.model]);
  const actualActiveModelInfo = useMemo(() => {
    if (!actualActiveModel) return undefined;
    return availableModels.find(m => m.id === actualActiveModel);
  }, [actualActiveModel, availableModels]);
  const actualActiveHarness = isAutoRouteActive && autoRouteDecision?.resolvedModel === actualActiveModel && autoRouteDecision?.resolvedHarness
    ? autoRouteDecision.resolvedHarness
    : inferHarnessFromModel(actualActiveModel);
  const actualActiveModelLabel = currentModel === PARABLE_MODE_ID && actualActiveModel === PARABLE_MODE_ID
    ? 'PARABLE'
    : formatHarnessModelLabel(
      actualActiveHarness,
      actualActiveModel,
      actualActiveModelInfo?.name,
    );
  const parableAgentLabel = activeParableAgent?.description.match(/\b(parable[-\w]*)/i)?.[1];
  const selectedModelLabel = currentModel === 'auto'
    ? 'AUTO'
    : currentModel === PARABLE_MODE_ID
      ? 'PARABLE'
      : formatHarnessModelLabel(inferHarnessFromModel(currentModel), currentModel, currentModelInfo.name) || currentModelInfo.name;
  const autoRouteScope = autoRouteDecision
    ? autoRouteDecision.categoryLabel || autoRouteDecision.categoryId || autoRouteDecision.tier
    : undefined;
  const modelButtonTitle = isSending && actualActiveModelLabel
    ? `Using ${actualActiveModelLabel}${isAutoRouteActive && autoRouteDecision && autoRouteScope ? `. Auto Build scope: ${autoRouteDecision.domain && autoRouteDecision.domain !== 'general' ? `${autoRouteScope}:${autoRouteDecision.domain}` : autoRouteScope}` : ''}`
    : `${currentModelInfo.description || selectedModelLabel} (click to change)`;

  // Load available models on mount
  useEffect(() => {
    if (availableModels.length === 0) {
      loadAvailableModels();
    }
  }, []);

  // Load message history for the active tab/session.
  useEffect(() => {
    let nextHistory: string[] = [];
    try {
      const stored = localStorage.getItem(`grep-history-${sessionId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          nextHistory = parsed.filter((item): item is string => typeof item === 'string');
        }
      }
    } catch {
      // Ignore parse errors
    }
    setShowMentions(false);
    setMentionQuery('');
    setMentionStartIndex(-1);
    setShowCommands(false);
    setCommandQuery('');
    setCommandStartIndex(-1);
    setMessageHistory(nextHistory);
    setShowHistory(false);
    setHistoryIndex(-1);
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
        if (hoverHarnessTimer.current) clearTimeout(hoverHarnessTimer.current);
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

  // Close the compact toolbar menu on outside click or Escape.
  useEffect(() => {
    if (!showToolbarOverflow) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (toolbarOverflowRef.current && !toolbarOverflowRef.current.contains(event.target as Node)) {
        setShowToolbarOverflow(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowToolbarOverflow(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showToolbarOverflow]);

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
      // Accept events from this session OR its root (BrowserPreview uses root session ID)
      const sessions = useSessionStore.getState().sessions;
      const thisSession = sessions.find(s => s.id === sessionId);
      const rootId = thisSession?.parentSessionId || sessionId;
      if (targetSessionId !== sessionId && targetSessionId !== rootId) return;

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
        if (suppressSubmittedInputEcho(content, 'browser-insert-chat')) {
          setTimeout(() => {
            textareaRef.current?.focus();
          }, 100);
          return;
        }
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
  }, [sessionId, setAttachments, setMessage, suppressSubmittedInputEcho]);

  // Listen for send-annotation events - sends IMMEDIATELY AND populates input for editing option
  useEffect(() => {
    const handleSendAnnotation = (event: CustomEvent<{ sessionId: string; content: string; screenshot?: string; alsoPopulateInput?: boolean }>) => {
      const { sessionId: targetSessionId, content, screenshot, alsoPopulateInput } = event.detail;
      const sessions = useSessionStore.getState().sessions;
      const thisSession = sessions.find(s => s.id === sessionId);
      const rootId = thisSession?.parentSessionId || sessionId;
      if (targetSessionId !== sessionId && targetSessionId !== rootId) return;

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
        if (!suppressSubmittedInputEcho(content, 'send-annotation')) {
          setMessage(content);
        }
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
  }, [sessionId, sendMessage, setAttachments, setMessage, suppressSubmittedInputEcho]);

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
  }, [selectedElement, setAttachments]);

  // Load commands, skills, and agents when session changes
  useEffect(() => {
    // Always seed the builtin commands so the autocomplete works even if
    // session lookup or extensions IPC fails (e.g. SSH session before worktree
    // is set up). These are the always-available items.
    const builtinCommands: SlashCommandItem[] = [
      { name: 'codex', description: 'Get a second opinion from OpenAI Codex', scope: 'builtin', itemType: 'codex' },
      { name: 'cascade', description: 'Enable Cascade evidence-gated workflow for the selected model', scope: 'builtin', itemType: 'cascade', cascadeEnabled: true },
      { name: 'cascade-off', description: 'Disable Cascade workflow', scope: 'builtin', itemType: 'cascade', cascadeEnabled: false },
      { name: 'monitor', description: '[Claude Code] Watch a long-running process and stream events', scope: 'builtin', itemType: 'claude-code' },
      { name: 'loop', description: '[Claude Code] Run a prompt on a recurring interval', scope: 'builtin', itemType: 'claude-code' },
    ];
    setCommands(builtinCommands as any);

    const currentSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (!currentSession) return;

    const projectPath = currentSession.worktreePath;
    const cacheKey = `${sessionId}:${projectPath || ''}`;
    const now = Date.now();
    const cached = extensionScanCache.get(cacheKey);

    let cancelled = false;
    let entry = cached && cached.expiresAt > now ? cached : null;
    if (!entry) {
      const promise = Promise.all([
        window.electronAPI.extensions.scanCommands({ sessionId, projectPath }),
        window.electronAPI.extensions.scanSkills({ sessionId, projectPath }),
        window.electronAPI.extensions.scanAgents({ sessionId, projectPath }),
        window.electronAPI.gstack.getModes(),
      ]).then(([cmds, skls, agts, gstackModes]) => {
        const gstackCommands: SlashCommandItem[] = (gstackModes || []).map((mode: { id: string; shortName: string; description: string }) => ({
          name: mode.shortName.toLowerCase(),
          description: `[GStack] ${mode.description}`,
          scope: 'gstack',
          itemType: 'gstack',
          gstackId: mode.id,
        }));
        gstackCommands.push({
          name: 'gstack-off',
          description: '[GStack] Deactivate current workflow mode',
          scope: 'gstack',
          itemType: 'gstack',
          gstackId: null,
        });
        return {
          commands: cmds || [],
          skills: skls || [],
          agents: agts || [],
          gstackCommands,
        };
      });
      entry = { expiresAt: now + EXTENSION_SCAN_CACHE_TTL_MS, promise };
      extensionScanCache.set(cacheKey, entry);
    }

    entry.promise.then(({ commands: loadedCommands, skills: loadedSkills, agents: loadedAgents, gstackCommands }) => {
      if (cancelled) return;
      setCommands([...loadedCommands, ...gstackCommands, ...builtinCommands] as any);
      setSkills(loadedSkills);
      setAgents(loadedAgents);
    }).catch(err => {
      extensionScanCache.delete(cacheKey);
      if (cancelled) return;
      console.error('[InputArea] Error loading extensions:', err);
    });

    return () => {
      cancelled = true;
    };
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
  }, [setMessage]);

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
    [message, mentionStartIndex, setAttachments, setMessage]
  );

  // Handle command/skill/agent selection
  const handleCommandSelect = useCallback(
    (item: any) => {
      const itemType = item.itemType || commandType;

      // Detect whether the autocomplete was opened by typing "/" (inline mode)
      // or by clicking the slash button (popover mode). In inline mode, a "/"
      // exists at commandStartIndex and needs to be replaced. In popover mode,
      // there's no "/" in the text — we insert fresh at the cursor.
      const isInlineMode = message[commandStartIndex] === '/';

      if (itemType === 'codex') {
        // Switch to Codex model — messages route through Codex SDK in the same chat
        const { availableModels, setSelectedModel } = useSessionStore.getState();
        const defaultCodexModel = availableModels.find((model) => model.id.startsWith('codex:'))?.id || 'codex:gpt-5.6-sol';
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
      } else if (itemType === 'cascade') {
        // Cascade is an independent workflow overlay. Toggling it must never
        // change the selected model or any GStack/parallel execution mode.
        setCascadeMode(sessionId, item.cascadeEnabled !== false);
        if (isInlineMode) {
          const beforeCommand = message.slice(0, commandStartIndex);
          setMessage(beforeCommand.trim());
        }
      } else if (itemType === 'command' || itemType === 'skill' || itemType === 'claude-code') {
        // Keep the invocation compact in the composer and transcript. The
        // main-process send boundary resolves its exact project/user workflow
        // definition for whichever harness ultimately handles the turn.
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
    [message, commandStartIndex, commandType, sessionId, setCascadeMode, setGStackMode]
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
  }, [setMessage]);

  const handleSubmit = async (planNudgeAction?: 'switch-to-plan' | 'keep-current' | 'suppress') => {
    if (!message.trim() && attachments.length === 0) return;
    if (disabled) return;

    // Intercept /btw — ephemeral side question (not added to history)
    const trimmed = message.trim();
    const cascadeCommand = trimmed.match(/^\/cascade(?:\s+(on|off))?$/i);
    if (cascadeCommand || /^\/cascade-off$/i.test(trimmed)) {
      const enabled = !/^\/cascade-off$/i.test(trimmed) && cascadeCommand?.[1]?.toLowerCase() !== 'off';
      setCascadeMode(sessionId, enabled);
      setMessage('');
      textareaRef.current?.focus();
      return;
    }

    if (/^\/btw\s+/i.test(trimmed)) {
      const question = trimmed.replace(/^\/btw\s+/i, '').trim();
      if (question) {
        rememberSubmittedInput(trimmed, question);
        setMessage('');
        await askBtw(sessionId, question);
        return;
      }
    }

    // If waiting for plan approval, treat input as plan feedback
    if (pendingPlanApproval && trimmed) {
      rememberSubmittedInput(trimmed);
      setMessage('');
      setAttachments([]);
      await rejectPlan(sessionId, trimmed);
      return;
    }

    // Note: We don't block on isSending - the store handles queueing if already streaming

    if (planNudgeAction === 'suppress') {
      suppressPlanModeNudge();
    }

    if (planNudgeAction === 'switch-to-plan') {
      setSelectedModel(sessionId, 'auto', 'plan-nudge');
      setPermissionMode(sessionId, 'plan');
    }

    if (
      !planNudgeAction &&
      !isSending &&
      !hasQueuedMessages &&
      shouldSuggestPlanModeNudge(message, attachments, currentModel, currentMode, cascadeActive)
    ) {
      setShowPlanModeNudge(true);
      textareaRef.current?.focus();
      return;
    }

    setShowPlanModeNudge(false);

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
    if (!fullMessage && otherAttachments.some((attachment) => attachment.type === 'file')) {
      fullMessage = 'Use the attached file(s) as input for the current task.';
    }
    console.log('[InputArea] Submitting with attachments:', otherAttachments.length);
    otherAttachments.forEach((a, i) => {
      console.log(`[InputArea] Attachment ${i}: type=${a.type}, name=${a.name}, content length=${a.content?.length || 0}`);
    });

    // Capture attachments before clearing state
    const attachmentsToSend = otherAttachments.length > 0 ? [...otherAttachments] : undefined;

    rememberSubmittedInput(message.trim(), fullMessage);
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
      if (modeChangeDisabled) return;
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
      rememberSubmittedInput(trimmedMessage);
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

    // Cmd/Ctrl+Shift+Enter: Fast Stack — stop the active turn, fork its
    // conversation once, and run this prompt immediately in the same chat pane.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
      e.preventDefault();
      const trimmedMessage = message.trim();
      if (!trimmedMessage && attachments.length === 0) return;
      const { fastStack } = useSessionStore.getState();
      rememberSubmittedInput(trimmedMessage);
      setMessage('');
      setAttachments([]);
      void fastStack(sessionId, trimmedMessage, attachments);
      return;
    }

    // Cmd/Ctrl+Enter: Force send — interrupt current stream and send immediately
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const trimmedMessage = message.trim();
      if (!trimmedMessage && attachments.length === 0) return;
      const { interruptAndSend } = useSessionStore.getState();
      rememberSubmittedInput(trimmedMessage);
      setMessage('');
      setAttachments([]);
      interruptAndSend(sessionId, trimmedMessage, attachments);
      return;
    }

    // Regular Enter (without Alt): Send message (queues if streaming)
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
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

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (file.size > MAX_DROPPED_FILE_BYTES) {
        console.warn(`[InputArea] File too large to attach: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      try {
        if (file.type.startsWith('image/')) {
          const base64Data = await readFileAsBase64(file);
          setAttachments(prev => [...prev, {
            type: 'image',
            name: file.name || `image-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
            content: base64Data,
          }]);
        } else if (isSupportedTextFile(file)) {
          const content = await readFileAsText(file);
          setAttachments(prev => [...prev, {
            type: 'file',
            name: file.name,
            content,
            metadata: { mimeType: file.type || 'text/plain', size: file.size, source: 'file-drop' },
          }]);
        } else {
          const base64Data = await readFileAsBase64(file);
          setAttachments(prev => [...prev, {
            type: 'file',
            name: file.name,
            content: base64Data,
            metadata: { mimeType: file.type || 'application/octet-stream', size: file.size, encoding: 'base64', source: 'file-drop' },
          }]);
        }
        console.log(`[InputArea] Attached file: ${file.name} (${file.type}, ${file.size} bytes)`);
      } catch (err) {
        console.error(`[InputArea] Failed to read file ${file.name}:`, err);
      }
    }
  }, [setAttachments]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await processFiles(files);
    }
  }, [processFiles]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [processFiles]);

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
        } else if (isSupportedTextFile(file)) {
          e.preventDefault();
          await processTextFile(file);
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
        } else if (item.kind === 'file') {
          const file = item.getAsFile();
          if (!file || !isSupportedTextFile(file)) continue;
          e.preventDefault();

          const alreadyProcessed = attachments.some(a =>
            a.type === 'file' && a.name === file.name && a.metadata?.size === file.size
          );
          if (!alreadyProcessed) {
            await processTextFile(file);
          }
        }
      }
    }

    async function processTextFile(file: File) {
      console.log('[InputArea] Processing text file:', file.name, file.type, file.size);
      if (file.size > MAX_PASTED_FILE_BYTES) {
        console.warn('[InputArea] Pasted file too large to attach:', file.name, file.size);
        return;
      }

      try {
        const content = await readFileAsText(file);
        const fileAttachment: Attachment = {
          type: 'file',
          name: file.name || `pasted-file-${Date.now()}.txt`,
          content,
          metadata: {
            mimeType: file.type || 'text/plain',
            size: file.size,
            source: 'clipboard-file',
          },
        };

        setAttachments(prev => [...prev, fileAttachment]);
        console.log('[InputArea] Text file pasted and attached:', fileAttachment.name, 'content length:', content.length);
      } catch (error) {
        console.error('[InputArea] Failed to read pasted text file:', error);
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
      const uiState = useUIStore.getState();
      const sessionState = useSessionStore.getState();
      const owner = sessionState.sessions.find((session) => session.id === sessionId);
      if (owner) {
        const existing = uiState.browserTabs.find((tab) => tab.ownerSessionId === sessionId);
        if (existing) uiState.setActiveBrowserTab(existing.id);
        else uiState.createBrowserTab(
          owner.id,
          getBrowserPartitionId(owner.id, sessionState.sessions),
          owner.lastBrowserUrl || `http://localhost:${owner.ports?.web || 3000}`,
        );
      }
      uiState.enableSessionBrowser(sessionId);
    }
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

  const toolbarActions: Array<{
    id: string;
    label: string;
    title: string;
    icon: React.ReactNode;
    onSelect: () => void;
    disabled?: boolean;
    active?: boolean;
    activeClassName?: string;
  }> = [
    {
      id: 'cascade',
      label: cascadeActive ? 'Disable Cascade' : 'Enable Cascade',
      title: cascadeActive
        ? `Cascade workflow is active for ${selectedModelLabel}. Click to disable.`
        : `Enable Cascade workflow for ${selectedModelLabel}. The selected model will not change.`,
      icon: <Workflow size={14} />,
      onSelect: () => setCascadeMode(sessionId, !cascadeActive),
      disabled: disabled || isSending,
      active: cascadeActive,
      activeClassName: 'text-cyan-400 bg-cyan-500/10',
    },
    {
      id: 'gstack',
      label: activeGStackMode ? `GStack: ${GSTACK_MODE_META[activeGStackMode]?.shortName || activeGStackMode}` : 'GStack Skills',
      title: 'GStack Skills',
      icon: (
        <span className="relative text-xs font-bold font-mono leading-none" style={{ fontSize: '13px' }}>
          G
          {activeGStackMode && <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-green-400" />}
        </span>
      ),
      onSelect: () => setShowGStack((current) => !current),
      disabled,
      active: Boolean(activeGStackMode || showGStack),
      activeClassName: 'text-claude-text bg-white/5',
    },
    {
      id: 'attach',
      label: 'Attach files',
      title: 'Attach files (or drag & drop)',
      icon: <Paperclip size={14} />,
      onSelect: () => fileInputRef.current?.click(),
      disabled,
    },
    {
      id: 'inspect',
      label: inspectorActive ? 'Cancel inspector' : 'Inspect element',
      title: inspectorActive ? 'Cancel inspector (click again)' : 'Inspect element',
      icon: <Target size={14} />,
      onSelect: handleInspectElement,
      disabled,
      active: inspectorActive,
      activeClassName: 'text-claude-accent bg-white/5',
    },
    {
      id: 'continue',
      label: 'Continue',
      title: 'Continue with next turn',
      icon: <RefreshCw size={14} />,
      onSelect: () => { void sendMessage(sessionId, 'continue'); },
      disabled,
    },
    {
      id: 'remote',
      label: remoteControl ? 'Stop phone control' : 'Control from phone',
      title: remoteControl ? 'Remote control active — click to stop' : 'Control from phone',
      icon: <Smartphone size={14} />,
      onSelect: () => {
        if (remoteControl) {
          useSessionStore.getState().stopRemoteControl(sessionId);
        } else {
          useSessionStore.getState().startRemoteControl(sessionId);
        }
      },
      disabled,
      active: Boolean(remoteControl),
      activeClassName: 'text-green-400 bg-green-500/10',
    },
  ];

  const visibleToolbarActions = toolbarActions.slice(0, visibleToolbarActionCount);
  const overflowToolbarActions = toolbarActions.slice(visibleToolbarActionCount);

  return (
    <>
      {/* Message Queue Panel */}
      <MessageQueuePanel sessionId={sessionId} />

      <div
        ref={containerRef}
        className={`build-composer-shell px-4 relative font-mono border-t ${voiceComposerExpanded ? 'build-composer-voice-active' : ''} ${isDragging ? 'border-claude-accent bg-claude-accent/5' : 'border-claude-border'}`}
        data-voice-composer-active={voiceComposerExpanded || undefined}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Hidden file input for paperclip button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-claude-bg/80 border-2 border-dashed border-claude-accent pointer-events-none">
            <div className="flex items-center gap-2 text-claude-accent font-mono text-sm">
              <Paperclip size={16} />
              <span>DROP FILES TO ATTACH</span>
            </div>
          </div>
        )}

        {compactionSwitch && (
          <CompactionSwitchNotice
            notice={compactionSwitch}
            availableModels={availableModels}
            onDismiss={() => dismissCompactionSwitch(sessionId)}
            onHandoff={(model) => handoffCompactionModel(sessionId, model)}
            onSwitchBack={() => restoreCompactionModel(sessionId)}
          />
        )}

        {currentModel === 'auto' && autoRouteDecision?.planningGate?.action === 'start' && (
          <div className="mb-2 flex items-center justify-between gap-3 border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-fuchsia-400">
                Pre-build 80/20 scope
              </div>
              <div className="truncate text-[10px] text-claude-text-secondary" title={autoRouteDecision.planningGate.reason}>
                {autoRouteDecision.planningGate.reason}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void (async () => {
                if (pendingPlanApproval) {
                  await rejectPlan(sessionId, 'User explicitly chose “Build now anyway”.');
                }
                await interruptAndSend(sessionId, '/build-now');
              })()}
              className="flex-none border border-claude-border px-2 py-1 text-[9px] font-mono uppercase text-claude-text-secondary hover:border-amber-500/50 hover:text-amber-400"
              title="Interrupt the scope pass and execute the original request with Auto Build's configured Execution model"
            >
              Build now anyway
            </button>
          </div>
        )}

        {currentModel === 'auto' && autoRouteDecision?.planningGate?.action === 'suggest' && (
          <div className="mb-2 flex items-center justify-between gap-3 border border-purple-500/20 bg-purple-500/5 px-3 py-2">
            <div className="min-w-0 truncate text-[10px] text-claude-text-secondary" title={autoRouteDecision.planningGate.reason}>
              This change may benefit from a quick 80/20 first-slice choice.
            </div>
            <button
              type="button"
              onClick={() => void interruptAndSend(sessionId, '/80-20-first')}
              className="flex-none border border-purple-500/30 px-2 py-1 text-[9px] font-mono uppercase text-purple-400 hover:bg-purple-500/10"
            >
              Run 80/20
            </button>
          </div>
        )}

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

      {showPlanModeNudge && !showCommands && !showMentions && (
        <div className="absolute bottom-full left-4 right-4 mb-2 bg-claude-surface border border-claude-border shadow-lg z-50 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Brain size={14} className="text-blue-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-claude-text font-mono">This looks like planning or copy strategy.</div>
              <div className="text-[11px] text-claude-text-secondary mt-1">
                Switch from {currentModelInfo.name} to Auto Build Plan before sending?
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <button
                type="button"
                onClick={() => void handleSubmit('switch-to-plan')}
                className="px-2 py-1 text-[11px] font-mono bg-blue-500/15 text-blue-300 border border-blue-500/30 hover:bg-blue-500/25"
              >
                Plan
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit('keep-current')}
                className="px-2 py-1 text-[11px] font-mono text-claude-text-secondary border border-claude-border hover:bg-claude-bg hover:text-claude-text"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit('suppress')}
                className="px-2 py-1 text-[11px] font-mono text-claude-text-secondary border border-claude-border hover:bg-claude-bg hover:text-claude-text"
              >
                Don't ask again
              </button>
            </div>
          </div>
        </div>
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
              placeholder={disabled ? 'session inactive...' : isVoiceModeActive ? 'add context or type message...' : isSending ? `type to queue message${hasQueuedMessages ? ` (${effectiveQueuedCount} queued)` : ''}...` : 'type here... (@ to mention, drop or paste files)'}
              disabled={disabled}
              className={`w-full py-0 resize-none focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed min-h-[24px] max-h-[200px] font-mono bg-transparent text-base text-claude-text placeholder:text-claude-text-secondary leading-6 caret-claude-accent ${
                useAudioStore.getState().recordingStates[sessionId]?.isRecording ? 'border-l-2 border-red-500 pl-2' : ''
              }`}
              rows={1}
            />
          </div>
        </div>

        {/* Unified toolbar: mode/effort/model left, icons right */}
        <div
          ref={toolbarRef}
          className="flex min-w-0 items-center gap-2 text-[10px] text-claude-text-secondary font-mono"
          style={{ letterSpacing: '0.03em' }}
        >
          <div ref={toolbarPrimaryRef} className="flex min-w-0 items-center gap-2">
          {/* Left: mode */}
          <button
            onClick={() => cyclePermissionMode(sessionId)}
            disabled={modeChangeDisabled}
            className={`flex-none hover:opacity-80 transition-opacity disabled:opacity-40 text-[10px] ${modeConfig.color}`}
            title={permissionModeTitle}
          >
            {modeConfig.label}
          </button>

        {/* HTML render mode toggle */}
        <div className="relative flex-none">
          <button
            onClick={() => cycleHtmlRenderMode(sessionId)}
            disabled={disabled}
            className={`flex items-center gap-0.5 hover:opacity-80 transition-opacity disabled:opacity-40 text-[10px] font-bold font-mono ${
              currentHtmlMode === 'html' ? 'text-purple-400' : 'text-claude-text-secondary'
            }`}
            title={currentHtmlMode === 'html' ? 'HTML mode: Claude responds in styled HTML (click to switch to Markdown)' : 'Markdown mode (click to switch to HTML)'}
            style={{ letterSpacing: '0.05em' }}
          >
            {currentHtmlMode === 'html' ? 'HTML' : 'MD'}
          </button>
        </div>

        {/* Effort level selector */}
        <div className="relative flex-none" ref={effortDropdownRef}>
          <button
            onClick={() => setShowEffortDropdown(!showEffortDropdown)}
            disabled={disabled}
            className={`flex items-center gap-1 hover:opacity-80 transition-opacity disabled:opacity-40 text-[10px] ${effortConfig.color}`}
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
        {/* Speed toggle */}
        <span
          onClick={() => { if (!disabled) toggleFastMode(); }}
          className={`flex-none cursor-pointer hover:opacity-80 text-[10px] ${
            fastMode ? 'text-amber-400' : 'text-claude-text-secondary'
          }`}
        >
          {fastMode ? 'FAST' : 'STD'}
        </span>
        <div className="relative min-w-0" ref={modelDropdownRef}>
          <button
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            disabled={disabled}
            className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-[10px] text-claude-text-secondary hover:text-claude-text transition-colors disabled:opacity-40"
            title={modelButtonTitle}
          >
            {currentModel === 'auto' ? (
              autoRouteDecision ? (
                <AutoRouteBadge
                  tier={autoRouteDecision.tier}
                  categoryId={autoRouteDecision.categoryId}
                  categoryLabel={autoRouteDecision.categoryLabel}
                  domain={autoRouteDecision.domain}
                  resolvedHarness={actualActiveHarness || autoRouteDecision.resolvedHarness}
                  modelLabel={actualActiveModelInfo?.name || autoRouteModelInfo?.name}
                  compact={!isSending}
                  planningGateAction={autoRouteDecision.planningGate?.action}
                />
              ) : (
                <span className="text-[10px] font-mono">
                  <span className="text-purple-400 font-bold">AUTO</span>
                </span>
              )
            ) : currentModel === PARABLE_MODE_ID ? (
              <span
                className="inline-flex min-w-0 max-w-[220px] items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-mono text-amber-400"
                title={modelButtonTitle}
              >
                <span className="font-bold tracking-wider">PARABLE</span>
                {isSending && (parableAgentLabel || (actualActiveModelLabel !== 'PARABLE' ? actualActiveModelLabel : undefined)) && (
                  <span className="min-w-0 truncate opacity-70">{parableAgentLabel || actualActiveModelLabel}</span>
                )}
              </span>
            ) : (
              <span className="font-mono">{isSending && actualActiveModelLabel ? actualActiveModelLabel : selectedModelLabel}</span>
            )}
          </button>
          {showModelDropdown && (() => {
            // Two-level menu: Harness → Models

            const groups: Record<string, typeof availableModels> = {};
            const groupOrder = ['claude', 'cursor', 'codex', 'gemini', 'opencode', 'custom'];
            const groupLabels: Record<string, string> = {
              claude: 'Claude',
              cursor: 'Cursor',
              codex: 'Codex',
              gemini: 'Gemini CLI',
              opencode: 'DeepSeek',
              custom: 'Custom',
            };

            const autoModel = availableModels.find(m => m.id === 'auto');
            const parableModel = availableModels.find(m => m.id === PARABLE_MODE_ID);

            for (const model of availableModels) {
              if (model.id === 'auto' || model.id === PARABLE_MODE_ID) continue;
              let group = 'claude';
              if (model.id.startsWith('codex:')) group = 'codex';
              else if (model.id.startsWith('cursor:')) group = 'cursor';
              else if (model.id.startsWith('gemini:')) group = 'gemini';
              else if (model.id.startsWith('opencode:')) group = 'opencode';
              else if (model.id.startsWith('custom:')) group = 'custom';
              if (!groups[group]) groups[group] = [];
              groups[group].push(model);
            }

            // Recently used: last 3
            const recentIds: string[] = JSON.parse(localStorage.getItem('grep-recent-models') || '[]').slice(0, 3);
            const recentModels = recentIds
              .map(id => availableModels.find(m => m.id === id))
              .filter((model): model is (typeof availableModels)[number] => Boolean(model) && model?.id !== 'auto' && model?.id !== PARABLE_MODE_ID);

            const selectModel = (modelId: string) => {
              setSelectedModel(sessionId, modelId);
              setShowModelDropdown(false);
              const recent = JSON.parse(localStorage.getItem('grep-recent-models') || '[]') as string[];
              const updated = [modelId, ...recent.filter(id => id !== modelId)].slice(0, 5);
              localStorage.setItem('grep-recent-models', JSON.stringify(updated));
            };

            // Workflow modes do not highlight a concrete executor harness.
            let currentHarness = currentModel === 'auto' || currentModel === PARABLE_MODE_ID ? '' : 'claude';
            if (currentModel.startsWith('codex:')) currentHarness = 'codex';
            else if (currentModel.startsWith('cursor:')) currentHarness = 'cursor';
            else if (currentModel.startsWith('gemini:')) currentHarness = 'gemini';
            else if (currentModel.startsWith('opencode:')) currentHarness = 'opencode';
            else if (currentModel.startsWith('custom:')) currentHarness = 'custom';

            const activeHarness = hoverHarness || currentHarness;
            const activeModels = groups[activeHarness] || [];

            return (
              <div className="absolute bottom-full left-0 mb-1 flex z-50">
                {/* Level 1: Harness list */}
                <div className="bg-claude-surface border border-claude-border shadow-lg min-w-32">
                  {/* Auto Build mode — intelligent routing */}
                  {autoModel && (
                    <>
                      <button
                        onClick={() => selectModel('auto')}
                        className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors ${
                          currentModel === 'auto' ? 'bg-purple-500/10 text-purple-400' : 'text-claude-text-secondary hover:bg-purple-500/5 hover:text-purple-300'
                        }`}
                      >
                        <span className="font-mono text-xs font-bold">
                          {currentModel === 'auto' && <span className="text-purple-400 mr-1">●</span>}
                          Auto Build
                        </span>
                      </button>
                    </>
                  )}
                  {/* Parable mode — Claude Code is the meta-harness */}
                  {parableModel && (
                    <button
                      onClick={() => selectModel(PARABLE_MODE_ID)}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors ${
                        currentModel === PARABLE_MODE_ID ? 'bg-amber-500/10 text-amber-400' : 'text-claude-text-secondary hover:bg-amber-500/5 hover:text-amber-300'
                      }`}
                    >
                      <span className="font-mono text-xs font-bold">
                        {currentModel === PARABLE_MODE_ID && <span className="text-amber-400 mr-1">●</span>}
                        Parable
                      </span>
                    </button>
                  )}
                  {(autoModel || parableModel) && <div className="border-b border-claude-border/30 my-0.5" />}
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
                        onMouseEnter={() => setHoverHarnessDebounced(key)}
                        onClick={() => { if (hoverHarnessTimer.current) clearTimeout(hoverHarnessTimer.current); setHoverHarness(key); }}
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
                  {activeModels.map(model => {
                    const costTier = model.id.includes('opus') ? '$$$' : model.id.includes('haiku') ? '$' : '$$';
                    const costColor = model.id.includes('opus') ? 'text-red-400' : model.id.includes('haiku') ? 'text-green-400' : 'text-amber-400';
                    return (
                    <button
                      key={model.id}
                      onClick={() => selectModel(model.id)}
                      className={`w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors ${
                        model.id === currentModel ? 'bg-claude-bg text-claude-accent' : 'text-claude-text'
                      }`}
                    >
                      <div className="font-mono text-xs flex items-center justify-between">
                        <span>{model.name.replace(/ \(Cursor\)| \(Codex\)/, '')}</span>
                        <span className={`text-[9px] ml-2 ${costColor}`}>{costTier}</span>
                      </div>
                    </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
        {/* Context usage indicator — pushed to far right */}
        {contextUsage && (
          <div className="flex flex-none items-center gap-1.5" title={`${contextUsage.inputTokens.toLocaleString()} / ${contextUsage.contextWindowSize.toLocaleString()} tokens (${contextUsage.percentage}%)`}>
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

          {/* Secondary actions collapse into an overflow menu as the pane narrows. */}
          <div className="ml-auto flex flex-none items-center gap-2">
            {visibleToolbarActions.map((action) => (
              <button
                key={action.id}
                onClick={action.onSelect}
                disabled={action.disabled}
                data-testid={action.id === 'cascade' ? 'cascade-mode-toggle' : undefined}
                aria-pressed={action.active || undefined}
                className={`flex h-6 w-6 flex-none items-center justify-center transition-colors hover:bg-claude-bg hover:text-claude-accent disabled:cursor-not-allowed disabled:opacity-40 ${
                  action.active
                    ? action.activeClassName || 'text-claude-accent bg-white/5'
                    : 'text-claude-text-secondary'
                }`}
                style={{ borderRadius: 0 }}
                title={action.title}
              >
                {action.icon}
              </button>
            ))}

            {overflowToolbarActions.length > 0 && (
              <div ref={toolbarOverflowRef} className="relative flex h-6 w-6 flex-none items-center justify-center">
                <button
                  onClick={() => setShowToolbarOverflow((current) => !current)}
                  data-testid="toolbar-overflow-toggle"
                  aria-expanded={showToolbarOverflow}
                  aria-haspopup="menu"
                  className={`flex h-6 w-6 items-center justify-center transition-colors hover:bg-claude-bg hover:text-claude-accent ${
                    showToolbarOverflow ? 'bg-white/5 text-claude-text' : 'text-claude-text-secondary'
                  }`}
                  style={{ borderRadius: 0 }}
                  title="More toolbar actions"
                >
                  <MoreHorizontal size={15} />
                </button>

                {showToolbarOverflow && (
                  <div
                    role="menu"
                    className="absolute bottom-full right-0 z-50 mb-1 min-w-48 border border-claude-border bg-claude-surface py-1 shadow-xl"
                  >
                    {overflowToolbarActions.map((action) => (
                      <button
                        key={action.id}
                        role="menuitem"
                        onClick={() => {
                          setShowToolbarOverflow(false);
                          action.onSelect();
                        }}
                        disabled={action.disabled}
                        data-testid={action.id === 'cascade' ? 'cascade-mode-toggle' : undefined}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-claude-bg disabled:cursor-not-allowed disabled:opacity-40 ${
                          action.active ? action.activeClassName || 'text-claude-accent' : 'text-claude-text'
                        }`}
                      >
                        <span className="flex h-4 w-4 flex-none items-center justify-center">{action.icon}</span>
                        <span>{action.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Stop remains pinned so it never enters overflow. */}
          <div ref={toolbarPinnedRef} data-testid="toolbar-pinned-controls" className="flex flex-none items-center gap-2">
            <VoiceComposerControl active={isActiveComposer} disabled={disabled} sessionId={sessionId} />
            {isSending && (
              <button
                onClick={handleStopStreaming}
                className="flex h-6 w-6 flex-none items-center justify-center text-red-400 transition-colors hover:bg-claude-bg hover:text-red-300 animate-pulse"
                style={{ borderRadius: 0 }}
                title="Stop (ESC ESC)"
              >
                <Square size={14} fill="currentColor" />
              </button>
            )}
          </div>

          {showGStack && (
            <GStackLauncher
              sessionId={sessionId}
              onClose={() => setShowGStack(false)}
            />
          )}
        </div>
      </div>
      </div>
    </>
  );
}

// ChatContainer receives token-frequency stream updates. Keep its large input
// tree out of those renders unless one of the input's own props or fine-grained
// store selectors actually changes.
export default React.memo(InputArea);
