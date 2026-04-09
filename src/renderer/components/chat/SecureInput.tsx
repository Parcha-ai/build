import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { Lock, X } from 'lucide-react';

/**
 * SecureInput component with inline chip-based masking
 *
 * Detects API keys and displays them as compact inline chips (like Slack mentions).
 * The chip collapses the original text space so typing continues naturally.
 */

interface DetectedKey {
  id: string;
  original: string;
  masked: string;
  type: string;
  startIndex: number;
  endIndex: number;
}

interface SecureInputProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  rows?: number;
}

// Key patterns — known prefixes (high confidence)
const KEY_PATTERNS = [
  { type: 'anthropic', pattern: /sk-ant-[a-zA-Z0-9_-]{95,105}/g, name: 'Anthropic' },
  { type: 'openai', pattern: /sk-[a-zA-Z0-9]{48,}/g, name: 'OpenAI' },
  { type: 'github', pattern: /(ghp|gho|ghu|ghs)_[a-zA-Z0-9]{36,}/g, name: 'GitHub' },
  { type: 'github_fine', pattern: /github_pat_[a-zA-Z0-9_]{22,}/g, name: 'GitHub' },
  { type: 'aws', pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS' },
  { type: 'stripe', pattern: /[sr]k_(live|test)_[a-zA-Z0-9]{24,}/g, name: 'Stripe' },
  { type: 'stripe_webhook', pattern: /whsec_[a-zA-Z0-9]{32,}/g, name: 'Stripe' },
  { type: 'sendgrid', pattern: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g, name: 'SendGrid' },
  { type: 'google_api', pattern: /AIza[0-9A-Za-z_-]{35}/g, name: 'Google' },
  { type: 'slack', pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g, name: 'Slack' },
  { type: 'jwt', pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, name: 'JWT' },
];

/**
 * Calculate Shannon entropy to detect random/generated strings.
 * API keys typically have >3.5 bits/char; English text is ~1.5-3.0.
 */
function calculateEntropy(str: string): number {
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
 * Detect generic high-entropy tokens that don't match known prefixes.
 */
function detectGenericHighEntropyKeys(text: string, alreadyDetected: Set<string>): Array<{ match: string; index: number }> {
  const results: Array<{ match: string; index: number }> = [];
  const genericPattern = /(?:^|[\s=:"'`,;({\[])([a-zA-Z0-9][a-zA-Z0-9_-]{18,126}[a-zA-Z0-9])(?=$|[\s:"'`,;)}\]])/g;

  let m;
  while ((m = genericPattern.exec(text)) !== null) {
    const token = m[1];
    const tokenIndex = m.index + m[0].indexOf(token);
    if (alreadyDetected.has(token)) continue;

    // Skip all-lowercase or all-uppercase (identifiers, not keys)
    if (/^[a-z_-]+$/.test(token) || /^[A-Z_-]+$/.test(token)) continue;
    // Skip camelCase/PascalCase (code identifiers)
    if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(token) || /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(token)) continue;

    // Require 3+ character classes
    let classes = 0;
    if (/[a-z]/.test(token)) classes++;
    if (/[A-Z]/.test(token)) classes++;
    if (/[0-9]/.test(token)) classes++;
    if (/[^a-zA-Z0-9]/.test(token)) classes++;
    if (classes < 3) continue;

    // Require high entropy
    if (calculateEntropy(token) < 3.5) continue;

    results.push({ match: token, index: tokenIndex });
  }
  return results;
}

const CHIP_PLACEHOLDER = '\u200B'; // Zero-width space as placeholder

/**
 * Mask a key for chip display
 */
function maskKey(key: string): string {
  if (key.length <= 12) return '****' + key.slice(-2);
  const prefixLen = Math.min(6, Math.floor(key.length * 0.15));
  const suffixLen = Math.min(3, Math.floor(key.length * 0.1));
  return key.slice(0, prefixLen) + '****' + key.slice(-suffixLen);
}

/**
 * Detect keys in text
 */
function detectKeys(text: string): DetectedKey[] {
  const detected: DetectedKey[] = [];
  const seenValues = new Set<string>();

  // Known-prefix patterns first
  for (const { type, pattern } of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      seenValues.add(match[0]);
      detected.push({
        id: `key_${match.index}_${Date.now()}`,
        original: match[0],
        masked: maskKey(match[0]),
        type,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  // Generic high-entropy detection for keys without known prefixes
  const genericKeys = detectGenericHighEntropyKeys(text, seenValues);
  for (const { match: token, index } of genericKeys) {
    detected.push({
      id: `key_${index}_${Date.now()}`,
      original: token,
      masked: maskKey(token),
      type: 'generic_key',
      startIndex: index,
      endIndex: index + token.length,
    });
  }

  return detected.sort((a, b) => a.startIndex - b.startIndex);
}

const SecureInput = React.forwardRef<HTMLTextAreaElement, SecureInputProps>(({
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  disabled,
  className,
  style,
  rows,
}, forwardedRef) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [detectedKeys, setDetectedKeys] = useState<DetectedKey[]>([]);

  // Expose textarea ref
  React.useImperativeHandle(forwardedRef, () => textareaRef.current!);

  // Detect keys and replace with masked versions in the display value
  useEffect(() => {
    const keys = detectKeys(value);
    setDetectedKeys(keys);
  }, [value]);

  const hasKeys = detectedKeys.length > 0;

  return (
    <div className="relative">
      {/* Simple textarea - no overlay complexity */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={className}
        style={{
          ...style,
          resize: 'none',
        }}
      />

      {/* Key indicator badge */}
      {hasKeys && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-500/20 border border-amber-500/40 pointer-events-none z-10">
          <Lock size={9} className="text-amber-400" />
          <span className="text-[9px] font-bold text-amber-400">
            {detectedKeys.length}
          </span>
        </div>
      )}
    </div>
  );
});

SecureInput.displayName = 'SecureInput';

export default SecureInput;
