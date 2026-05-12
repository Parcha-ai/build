export function isHtmlResponse(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<!DOCTYPE html>') ||
         trimmed.startsWith('<!doctype html>') ||
         /^<html[\s>]/i.test(trimmed);
}
