export const ZAI_GLM_CLAUDE_MODEL_PICKER_ID = 'custom:zai-glm-5.2';
export const ZAI_GLM_CODEX_MODEL_PICKER_ID = 'codex:glm-5.2';

export const ZAI_GLM_CLAUDE_MODEL_ID = 'glm-5.2[1m]';
export const ZAI_GLM_CODEX_MODEL_ID = 'glm-5.2';
export const ZAI_GLM_FAST_MODEL_ID = 'glm-4.5-air';

export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
export const ZAI_OPENAI_COMPAT_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_GLM_CONTEXT_WINDOW = 1000000;

export function isZaiGlmClaudePickerModel(model?: string | null): boolean {
  return model === ZAI_GLM_CLAUDE_MODEL_PICKER_ID;
}

export function isZaiGlmCodexModel(model?: string | null): boolean {
  const normalized = (model || '').replace(/^codex:/, '').toLowerCase();
  return normalized === ZAI_GLM_CODEX_MODEL_ID || normalized === ZAI_GLM_CLAUDE_MODEL_ID.toLowerCase();
}

