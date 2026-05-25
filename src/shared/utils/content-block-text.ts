export interface ContentBlockTextExtraction {
  matched: boolean;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonLike(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'));
}

export function extractContentBlockText(value: unknown): ContentBlockTextExtraction {
  if (typeof value === 'string') {
    if (!isJsonLike(value)) return { matched: false, text: '' };
    try {
      return extractContentBlockText(JSON.parse(value));
    } catch {
      return { matched: false, text: '' };
    }
  }

  if (Array.isArray(value)) {
    let matched = false;
    const parts: string[] = [];

    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }

      const extracted = extractContentBlockText(item);
      if (extracted.matched) {
        matched = true;
        if (extracted.text) {
          parts.push(extracted.text);
        }
      }
    }

    return matched
      ? { matched: true, text: parts.filter(Boolean).join('\n') }
      : { matched: false, text: '' };
  }

  if (!isRecord(value)) return { matched: false, text: '' };

  const type = typeof value.type === 'string' ? value.type : undefined;
  if (type === 'text') {
    return { matched: true, text: typeof value.text === 'string' ? value.text : '' };
  }

  if (type === 'image') {
    return { matched: true, text: '' };
  }

  if ('content' in value) {
    const nested = extractContentBlockText(value.content);
    if (nested.matched) return nested;
    if (type && typeof value.content === 'string') {
      return { matched: true, text: value.content };
    }
  }

  return { matched: false, text: '' };
}

export function stringifyToolResultForDisplay(value: unknown): string {
  const extracted = extractContentBlockText(value);
  if (extracted.matched) return extracted.text;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
