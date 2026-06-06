import type { AutoRouterConfig } from './types';

export const LOCAL_MODE_DEFAULT_MODEL = 'opencode:ollama/qwen3-coder-64k';
export const LOCAL_MODE_DEFAULT_SMALL_MODEL = 'opencode:ollama/qwen2.5-coder:1.5b';
export const LOCAL_MODE_DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const LOCAL_MODE_MODEL_PREFIX = 'opencode:ollama/';
const OLLAMA_MODEL_PREFIX = 'ollama/';

export const LOCAL_MODE_MODELS: Array<{ id: string; name: string; description: string }> = [
  {
    id: LOCAL_MODE_DEFAULT_MODEL,
    name: 'Qwen3-Coder 30B 64K (Local)',
    description: 'Local Ollama model via OpenCode. Requires qwen3-coder-64k to be pulled and warmed up.',
  },
  {
    id: LOCAL_MODE_DEFAULT_SMALL_MODEL,
    name: 'Qwen2.5-Coder 1.5B (Local)',
    description: 'Small local Ollama fallback for light offline edits and smoke tests.',
  },
];

export function getLocalModeModelEntries(settings?: Record<string, unknown>): Array<{ id: string; name: string; description: string }> {
  const entries = [...LOCAL_MODE_MODELS];
  const addConfiguredModel = (id: string, name: string) => {
    if (!id || entries.some((entry) => entry.id === id)) return;
    entries.push({
      id,
      name,
      description: 'Configured local Ollama model via OpenCode.',
    });
  };

  addConfiguredModel(getLocalModeModel(settings), `${getOllamaModelName(getLocalModeModel(settings)) || 'Local model'} (Local)`);
  addConfiguredModel(getLocalModeSmallModel(settings), `${getOllamaModelName(getLocalModeSmallModel(settings)) || 'Local small model'} (Local)`);
  return entries;
}

export function getLocalModeModel(settings?: Record<string, unknown>): string {
  const configured = settings?.localModeModel;
  return normalizeLocalOllamaModelId(configured, LOCAL_MODE_DEFAULT_MODEL);
}

export function getLocalModeSmallModel(settings?: Record<string, unknown>): string {
  const configured = settings?.localModeSmallModel;
  return normalizeLocalOllamaModelId(configured, LOCAL_MODE_DEFAULT_SMALL_MODEL);
}

export function getLocalOllamaBaseUrl(settings?: Record<string, unknown>): string {
  const configured = settings?.localOllamaBaseUrl;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : LOCAL_MODE_DEFAULT_OLLAMA_BASE_URL;
}

export function isLocalModeEnabled(settings?: Record<string, unknown>): boolean {
  return settings?.localModeEnabled === true;
}

export function normalizeLocalOllamaModelId(value: unknown, fallback = LOCAL_MODE_DEFAULT_MODEL): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith(LOCAL_MODE_MODEL_PREFIX)) {
    return trimmed.slice(LOCAL_MODE_MODEL_PREFIX.length).trim() ? trimmed : fallback;
  }
  if (trimmed.startsWith(OLLAMA_MODEL_PREFIX)) {
    return trimmed.slice(OLLAMA_MODEL_PREFIX.length).trim() ? `opencode:${trimmed}` : fallback;
  }

  // Treat a plain Ollama tag as local. Reject namespaced/cloud ids so Local Mode
  // cannot accidentally fall through to Claude/Codex/etc. when enabled.
  if (!trimmed.includes('/') && !trimmed.includes(':')) return `${LOCAL_MODE_MODEL_PREFIX}${trimmed}`;
  if (/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(trimmed) && !trimmed.startsWith('opencode:')) {
    return `${LOCAL_MODE_MODEL_PREFIX}${trimmed}`;
  }
  return fallback;
}

export function isLocalOllamaModel(model?: string | null): boolean {
  if (!model) return false;
  const trimmed = model.trim();
  const modelId = trimmed.startsWith('opencode:') ? trimmed.replace('opencode:', '') : trimmed;
  return modelId.startsWith(OLLAMA_MODEL_PREFIX);
}

export function getOllamaModelName(model?: string | null): string {
  const normalized = normalizeLocalOllamaModelId(model, '');
  return normalized.startsWith(LOCAL_MODE_MODEL_PREFIX)
    ? normalized.slice(LOCAL_MODE_MODEL_PREFIX.length)
    : '';
}

export function buildLocalModeAutoRouterConfig(model: string): AutoRouterConfig {
  return {
    enabled: true,
    planModel: model,
    buildModel: model,
    verifyModel: model,
    refineModel: model,
    fallbackModel: model,
    costAware: false,
    costThresholdPercent: 100,
  };
}

export function buildOpenCodeOllamaProviderConfig(settings?: Record<string, unknown>) {
  const primaryModel = getOllamaModelName(getLocalModeModel(settings));
  const smallModel = getOllamaModelName(getLocalModeSmallModel(settings));
  const models: Record<string, { name: string; tools: boolean }> = {};

  if (primaryModel) {
    models[primaryModel] = {
      name: 'Qwen3-Coder 30B (64k)',
      tools: true,
    };
  }

  if (smallModel && smallModel !== primaryModel) {
    models[smallModel] = {
      name: 'Qwen2.5-Coder 1.5B',
      tools: true,
    };
  }

  return {
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: {
          baseURL: getLocalOllamaBaseUrl(settings),
        },
        models,
      },
    },
    enabled_providers: ['ollama'],
    autoupdate: false,
    share: 'disabled',
  };
}
