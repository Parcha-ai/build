/**
 * Secure Keys Service
 *
 * Manages temporary in-memory storage of API keys and tokens detected in chat messages.
 * Keys are never persisted to disk or transcripts - only stored in memory during the session.
 *
 * Security features:
 * - Memory-only storage (cleared on app restart)
 * - Session-scoped (keys tied to session ID)
 * - Automatic cleanup on session end
 * - No logging of actual key values
 */

import { randomBytes } from 'crypto';

export interface SecureKey {
  id: string;           // Reference ID (e.g., "key_abc123")
  sessionId: string;    // Session this key belongs to
  type: string;         // Key type (e.g., "anthropic", "openai", "github")
  value: string;        // The actual key value (never logged or persisted)
  envVarName?: string;  // Environment variable name if detected from CAPS=value pattern
  detectedAt: number;   // Timestamp when detected
  lastAccessedAt: number | null; // Last time agent accessed this key
}

interface DetectedKey {
  value: string;
  type: string;
  description: string;
  envVarName?: string;
}

export class SecureKeysService {
  // In-memory storage only - never persisted
  private keys = new Map<string, SecureKey>();

  private readonly ENV_ASSIGNMENT_PATTERN = /^(?:\s*export\s+)?([A-Z][A-Z0-9_]{1,127})=(.*)$/gm;
  private readonly SECRET_ENV_NAME_PATTERNS = [
    /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|SECRET_KEY|TOKEN|PASSWORD|PASS|PRIVATE_KEY|CLIENT_SECRET|AUTH_TOKEN|SESSION_TOKEN|PAT)$/i,
    /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i,
  ];
  private readonly NON_SECRET_ENV_NAME_PATTERNS = [
    /(?:^|_)(?:URL|URI|HOST|PORT|TARGET|BACKEND|ENDPOINT|REGION|MODEL|PROJECT|USERNAME|USER|ORG|ORGANIZATION|ENV|ENVIRONMENT)$/i,
    /^USE_/i,
    /^ENABLE_/i,
    /^IS_/i,
    /^HAS_/i,
  ];

  // Key type detection patterns — ordered from most specific to least specific
  private readonly KEY_PATTERNS = [
    // Provider-specific patterns (high confidence, known prefixes)
    { type: 'anthropic', pattern: /\bsk-ant-[a-zA-Z0-9_-]{95,105}\b/g, description: 'Anthropic API Key' },
    { type: 'openai', pattern: /\bsk-[a-zA-Z0-9]{48,}\b/g, description: 'OpenAI API Key' },
    { type: 'github_token', pattern: /\bghp_[a-zA-Z0-9]{36,}\b/g, description: 'GitHub Personal Access Token' },
    { type: 'github_oauth', pattern: /\bgho_[a-zA-Z0-9]{36,}\b/g, description: 'GitHub OAuth Token' },
    { type: 'github_app', pattern: /\b(ghu|ghs)_[a-zA-Z0-9]{36,}\b/g, description: 'GitHub App Token' },
    { type: 'github_fine', pattern: /\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g, description: 'GitHub Fine-grained PAT' },
    { type: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, description: 'AWS Access Key' },
    { type: 'stripe', pattern: /\b[sr]k_(live|test)_[a-zA-Z0-9]{24,}\b/g, description: 'Stripe API Key' },
    { type: 'stripe_webhook', pattern: /\bwhsec_[a-zA-Z0-9]{32,}\b/g, description: 'Stripe Webhook Secret' },
    { type: 'twilio', pattern: /\bSK[a-z0-9]{32}\b/g, description: 'Twilio API Key' },
    { type: 'google_api', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, description: 'Google API Key' },
    { type: 'slack', pattern: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}\b/g, description: 'Slack Token' },
    { type: 'sendgrid', pattern: /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}\b/g, description: 'SendGrid API Key' },
    { type: 'supabase', pattern: /\bsbp_[a-f0-9]{40}\b/g, description: 'Supabase Service Key' },
    { type: 'vercel', pattern: /\b[a-zA-Z0-9]{24}_[a-zA-Z0-9]{24,}\b/g, description: 'Vercel Token' },
    { type: 'bearer', pattern: /\bBearer\s+[a-zA-Z0-9_-]{20,}\b/gi, description: 'Bearer Token' },
    { type: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, description: 'JWT Token' },
  ];

  // Words that are NOT API keys (common English words, CLI args, hashes that appear in normal usage)
  private readonly FALSE_POSITIVE_WORDS = new Set([
    // Common long words/patterns that could be false positives
    'authentication', 'authorization', 'configuration', 'implementation',
    'documentation', 'representation', 'transformation', 'infrastructure',
    'internationally', 'acknowledgement', 'unsubscribe', 'troubleshooting',
  ]);

  /**
   * Calculate Shannon entropy of a string (bits per character).
   * High-entropy strings (>3.5 bits/char) are likely random/generated keys.
   * Normal English text is ~1.5-3.0 bits/char.
   */
  private calculateEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const char of str) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Count how many character classes are present in a string.
   * API keys typically have 3+ classes (upper, lower, digits, special).
   */
  private countCharClasses(str: string): number {
    let classes = 0;
    if (/[a-z]/.test(str)) classes++;
    if (/[A-Z]/.test(str)) classes++;
    if (/[0-9]/.test(str)) classes++;
    if (/[^a-zA-Z0-9]/.test(str)) classes++;
    return classes;
  }

  /**
   * Detect generic high-entropy tokens that don't match known prefixes.
   * Uses Shannon entropy + character class diversity to distinguish
   * random API keys from normal text.
   */
  private detectGenericHighEntropyKeys(text: string, alreadyDetected: Set<string>): DetectedKey[] {
    const detected: DetectedKey[] = [];

    // Match standalone tokens: alphanumeric with dashes/underscores, 20-128 chars
    const genericPattern = /(?:^|[\s=:"'`,;({\[])([a-zA-Z0-9][a-zA-Z0-9_-]{18,126}[a-zA-Z0-9])(?=$|[\s:"'`,;)}\]])/g;

    let match;
    while ((match = genericPattern.exec(text)) !== null) {
      const token = match[1];

      // Skip if already caught by a prefix pattern
      if (alreadyDetected.has(token)) continue;

      // Skip if it's a known non-secret word
      if (this.FALSE_POSITIVE_WORDS.has(token.toLowerCase())) continue;

      // Skip if it looks like a file path, URL component, or CSS class
      if (/^(https?|ftp|ssh|file|mailto|data)$/i.test(token)) continue;
      if (/^(node_modules|src|dist|build|public|assets|components)$/i.test(token)) continue;

      // Skip if it's all one case with no digits (likely a regular word or identifier)
      if (/^[a-z_-]+$/.test(token) || /^[A-Z_-]+$/.test(token)) continue;

      // Skip camelCase/PascalCase identifiers (common in code)
      if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(token) || /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(token)) continue;

      // Require at least 3 character classes (e.g. upper + lower + digit)
      const charClasses = this.countCharClasses(token);
      if (charClasses < 3) continue;

      // Require high Shannon entropy (>3.5 bits/char for 20+ char strings)
      const entropy = this.calculateEntropy(token);
      if (entropy < 3.5) continue;

      // Passed all checks — this looks like a random key/token
      detected.push({
        value: token,
        type: 'generic_key',
        description: 'API Key or Token',
      });
    }

    return detected;
  }

  /**
   * Detect and extract API keys from text
   * Returns array of detected keys with their types
   */
  detectKeys(text: string): DetectedKey[] {
    const detected = this.detectEnvVarKeys(text);
    const seenValues = new Set(detected.map((key) => key.value));

    // Run known-prefix patterns first
    for (const { type, pattern, description } of this.KEY_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        for (const value of matches) {
          if (!seenValues.has(value)) {
            detected.push({ value, type, description });
            seenValues.add(value);
          }
        }
      }
    }

    // Then run generic high-entropy detection for keys without known prefixes
    const genericKeys = this.detectGenericHighEntropyKeys(text, seenValues);
    for (const key of genericKeys) {
      if (!seenValues.has(key.value)) {
        detected.push(key);
        seenValues.add(key.value);
      }
    }

    return detected;
  }

  /**
   * Store a key securely and return reference ID
   */
  storeKey(sessionId: string, keyValue: string, keyType: string, envVarName?: string): string {
    const id = this.generateKeyId();

    const secureKey: SecureKey = {
      id,
      sessionId,
      type: keyType,
      value: keyValue,
      envVarName,
      detectedAt: Date.now(),
      lastAccessedAt: null,
    };

    this.keys.set(id, secureKey);
    console.log(`[SecureKeys] Stored ${keyType} key with ID ${id} for session ${sessionId}`);

    return id;
  }

  /**
   * Retrieve a key by its reference ID
   * Updates lastAccessedAt timestamp
   */
  getKey(keyId: string): string | null {
    const key = this.keys.get(keyId);
    if (!key) {
      console.warn(`[SecureKeys] Key ${keyId} not found`);
      return null;
    }

    key.lastAccessedAt = Date.now();
    console.log(`[SecureKeys] Key ${keyId} (${key.type}) accessed by session ${key.sessionId}`);

    return key.value;
  }

  /**
   * Get all key IDs for a session (without revealing actual values)
   */
  getSessionKeys(sessionId: string): Array<{ id: string; type: string; description: string }> {
    const sessionKeys: Array<{ id: string; type: string; description: string }> = [];

    for (const key of this.keys.values()) {
      if (key.sessionId === sessionId) {
        const pattern = this.KEY_PATTERNS.find(p => p.type === key.type);
        sessionKeys.push({
          id: key.id,
          type: key.type,
          description: key.envVarName
            ? `Environment Variable: ${key.envVarName}`
            : (pattern?.description || key.type),
        });
      }
    }

    return sessionKeys;
  }

  getSessionEnvVars(sessionId: string): Array<{ name: string; value: string; type: string; description: string }> {
    const envVars: Array<{ name: string; value: string; type: string; description: string }> = [];

    for (const key of this.keys.values()) {
      if (key.sessionId !== sessionId || !key.envVarName) {
        continue;
      }

      envVars.push({
        name: key.envVarName,
        value: key.value,
        type: key.type,
        description: `Environment Variable: ${key.envVarName}`,
      });
    }

    envVars.sort((a, b) => a.name.localeCompare(b.name));
    return envVars;
  }

  /**
   * Process message text: detect keys, store them, and replace with placeholders
   * Returns modified text and info about detected keys
   */
  interceptAndReplaceKeys(
    sessionId: string,
    text: string
  ): { modifiedText: string; keysDetected: Array<{ id: string; type: string; description: string }> } {
    const detected = this.detectKeys(text);

    if (detected.length === 0) {
      return { modifiedText: text, keysDetected: [] };
    }

    let modifiedText = text;
    const keysDetected: Array<{ id: string; type: string; description: string }> = [];

    // Store each key and replace with placeholder
    for (const { value, type, description, envVarName } of detected) {
      const keyId = this.storeKey(sessionId, value, type, envVarName);

      // Replace the actual key with a secure placeholder
      // The agent can retrieve it via tool call if needed
      const placeholder = `[SECURE_KEY:${keyId}]`;
      modifiedText = modifiedText.replace(value, placeholder);

      keysDetected.push({ id: keyId, type, description });
    }

    console.log(`[SecureKeys] Intercepted ${keysDetected.length} key(s) in session ${sessionId}`);

    return { modifiedText, keysDetected };
  }

  /**
   * Clear all keys for a session (called when session ends)
   */
  clearSessionKeys(sessionId: string): void {
    let cleared = 0;

    for (const [id, key] of this.keys.entries()) {
      if (key.sessionId === sessionId) {
        this.keys.delete(id);
        cleared++;
      }
    }

    if (cleared > 0) {
      console.log(`[SecureKeys] Cleared ${cleared} key(s) for session ${sessionId}`);
    }
  }

  /**
   * Clear all keys (called on app shutdown)
   */
  clearAllKeys(): void {
    const count = this.keys.size;
    this.keys.clear();
    console.log(`[SecureKeys] Cleared all ${count} stored key(s)`);
  }

  /**
   * Get statistics (for debugging, never exposes actual keys)
   */
  getStats(): { totalKeys: number; keysByType: Record<string, number> } {
    const keysByType: Record<string, number> = {};

    for (const key of this.keys.values()) {
      keysByType[key.type] = (keysByType[key.type] || 0) + 1;
    }

    return {
      totalKeys: this.keys.size,
      keysByType,
    };
  }

  /**
   * Generate a unique key ID
   */
  private generateKeyId(): string {
    return `key_${randomBytes(8).toString('hex')}`;
  }

  private detectEnvVarKeys(text: string): DetectedKey[] {
    const detected: DetectedKey[] = [];
    const seen = new Set<string>();

    for (const match of text.matchAll(this.ENV_ASSIGNMENT_PATTERN)) {
      const envVarName = match[1];
      const rawValue = match[2];

      if (!this.isSensitiveEnvVarName(envVarName)) {
        continue;
      }

      const value = this.extractEnvVarValue(rawValue);
      if (!value || this.isClearlyNonSecretValue(value)) {
        continue;
      }

      const dedupeKey = `${envVarName}:${value}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      detected.push({
        value,
        type: 'env_var',
        description: `Environment Variable: ${envVarName}`,
        envVarName,
      });
      seen.add(dedupeKey);
    }

    return detected;
  }

  private isSensitiveEnvVarName(envVarName: string): boolean {
    if (this.NON_SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(envVarName))) {
      return false;
    }

    return this.SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(envVarName));
  }

  private extractEnvVarValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return '';
    }

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
      return trimmed.slice(1, -1);
    }

    return trimmed.replace(/\s+#.*$/, '').trim();
  }

  private isClearlyNonSecretValue(value: string): boolean {
    if (!value) {
      return true;
    }

    if (/^\[SECURE_KEY:[^\]]+\]$/.test(value)) {
      return true;
    }

    return /^(true|false|null|undefined|yes|no|on|off)$/i.test(value);
  }
}

// Singleton instance
export const secureKeysService = new SecureKeysService();
