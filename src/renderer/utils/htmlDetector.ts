export interface HtmlDetectionOptions {
  allowFragment?: boolean;
}

const HTML_FENCE_RE = /^```(?:html)?\s*\n([\s\S]*?)```\s*$/i;
const FULL_HTML_RE = /^(?:<!doctype\s+html>|<html[\s>])/i;
const HTML_FRAGMENT_START_RE = /^<(?:head|body|main|section|article|div|span|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|style|script|svg|canvas|details|summary|pre|code|form|button|input|label|header|footer|nav|aside|figure|figcaption|img|a|meta|link)[\s>/]/i;
const HTML_TAG_RE = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/gi;
const HTML_CLOSING_TAG_RE = /<\/[a-z][\w:-]*\s*>/gi;

export function extractHtml(text: string): string {
  const trimmed = text.trimStart();
  const fenceMatch = trimmed.match(HTML_FENCE_RE);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

function isCompleteHtmlDocument(text: string): boolean {
  return FULL_HTML_RE.test(text.trimStart());
}

function looksLikeHtmlFragment(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  if (isCompleteHtmlDocument(trimmed)) return true;
  if (HTML_FRAGMENT_START_RE.test(trimmed)) return true;

  const tagMatches = trimmed.match(HTML_TAG_RE) || [];
  const closingMatches = trimmed.match(HTML_CLOSING_TAG_RE) || [];
  return tagMatches.length >= 2 && closingMatches.length >= 1;
}

export function isHtmlResponse(text: string, options: HtmlDetectionOptions = {}): boolean {
  const html = extractHtml(text);
  if (isCompleteHtmlDocument(html)) return true;
  if (options.allowFragment) return looksLikeHtmlFragment(html);
  return false;
}
