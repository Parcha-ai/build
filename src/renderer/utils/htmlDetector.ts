export function extractHtml(text: string): string {
  const trimmed = text.trimStart();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

export function isHtmlResponse(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!DOCTYPE html>') ||
      trimmed.startsWith('<!doctype html>') ||
      /^<html[\s>]/i.test(trimmed)) {
    return true;
  }
  // Also detect HTML wrapped in code fences (```html or ```)
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trimStart();
    return inner.startsWith('<!DOCTYPE html>') ||
           inner.startsWith('<!doctype html>') ||
           /^<html[\s>]/i.test(inner);
  }
  return false;
}
