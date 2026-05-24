export interface PromptTruncationOptions {
  marker?: string;
  tailRatio?: number;
}

export function truncateMiddlePreservingTail(
  value: string,
  maxChars: number,
  options: PromptTruncationOptions = {},
): string {
  if (value.length <= maxChars) return value;

  const marker = options.marker || '\n\n[... middle truncated due to length ...]\n\n';
  if (maxChars <= marker.length + 2) {
    return value.slice(0, maxChars);
  }

  const tailRatio = Math.min(Math.max(options.tailRatio ?? 0.7, 0.1), 0.9);
  const tailChars = Math.min(
    Math.floor(maxChars * tailRatio),
    maxChars - marker.length - 1,
  );
  const headChars = maxChars - marker.length - tailChars;

  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}
