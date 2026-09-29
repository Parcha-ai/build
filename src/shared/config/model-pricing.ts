export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per 1M tokens. This is the single catalog used by analytics and Parable.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.50 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-0': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-3-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.50, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 2.50 },
  'gpt-5.6-luna': { input: 1, output: 6, cacheRead: 0.10, cacheWrite: 1 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.50, cacheWrite: 5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4': { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 2.50 },
  'gpt-5.3-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'o3': { input: 2, output: 8, cacheRead: 0.50, cacheWrite: 2 },
  'composer-2.5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3 },
  'gemini-3.5-flash': { input: 1.50, output: 9, cacheRead: 0.15, cacheWrite: 1.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, cacheRead: 0.03, cacheWrite: 0.30 },
  'deepseek-v4-flash': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-v4-pro': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  'deepseek-v3.2': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'glm-5.2': { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 0 },
};

export const DEFAULT_MODEL_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.30,
  cacheWrite: 3.75,
};

const SORTED_MODEL_PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/** Returns undefined for a genuinely unknown/custom model so callers can request an override. */
export function getKnownModelPricing(modelId: string): ModelPricing | undefined {
  const normalized = modelId.toLowerCase();
  for (const key of SORTED_MODEL_PRICING_KEYS) {
    if (normalized.includes(key) || normalized.includes(key.replace('claude-', ''))) {
      return MODEL_PRICING[key];
    }
  }
  if (normalized.includes('fable')) return MODEL_PRICING['claude-fable-5'];
  if (normalized.includes('opus')) return MODEL_PRICING['claude-opus-5'];
  if (normalized.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (normalized.includes('sonnet')) return MODEL_PRICING['claude-sonnet-5'];
  if (normalized.includes('composer')) return MODEL_PRICING['composer-2.5'];
  if (normalized.includes('gemini') && normalized.includes('flash')) return MODEL_PRICING['gemini-2.5-flash'];
  if (normalized.includes('gemini') && normalized.includes('pro')) return MODEL_PRICING['gemini-2.5-pro'];
  if (normalized.includes('deepseek')) return MODEL_PRICING['deepseek-chat'];
  if (normalized.includes('glm-5.2') || normalized.includes('zai-glm')) return MODEL_PRICING['glm-5.2'];
  return undefined;
}

export function getModelPricing(modelId: string): ModelPricing {
  return getKnownModelPricing(modelId) || DEFAULT_MODEL_PRICING;
}
