/**
 * Embedded API keys for voice features
 *
 * These keys are baked into the build at compile time via Webpack DefinePlugin.
 * They provide out-of-the-box voice functionality without user configuration.
 *
 * Priority: User-provided keys (in Settings) take precedence over embedded keys.
 *
 * To update keys:
 * 1. Edit .env.production with new key values
 * 2. Rebuild the application
 */

// Declare process.env types for build-time injected values
declare const process: {
  env: {
    EMBEDDED_OPENAI_API_KEY?: string;
    EMBEDDED_CEREBRAS_API_KEY?: string;
    EMBEDDED_ELEVENLABS_API_KEY?: string;
  };
};

export const EMBEDDED_KEYS = {
  openAi: process.env.EMBEDDED_OPENAI_API_KEY || '',
  cerebras: process.env.EMBEDDED_CEREBRAS_API_KEY || '',
  elevenLabs: process.env.EMBEDDED_ELEVENLABS_API_KEY || '',
} as const;

export function hasEmbeddedOpenAiKey(): boolean {
  return Boolean(EMBEDDED_KEYS.openAi);
}

export function hasEmbeddedElevenLabsKey(): boolean {
  return Boolean(EMBEDDED_KEYS.elevenLabs);
}
