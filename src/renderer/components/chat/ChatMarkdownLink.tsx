import React from 'react';
import { chatFilePathFromHref, classifyChatLink } from '../../../shared/utils/chat-links';
import { useEditorStore } from '../../stores/editor.store';
import { openLinkInAppBrowser } from '../../utils/open-link-in-browser';

interface ChatMarkdownLinkProps {
  href?: string;
  sessionId?: string;
  children: React.ReactNode;
}

export default function ChatMarkdownLink({ href = '', sessionId, children }: ChatMarkdownLinkProps) {
  const linkText = typeof children === 'string' ? children : String(children);
  const kind = classifyChatLink(href, linkText);
  const isLocal = kind === 'local-editor' || kind === 'local-artifact';
  const title = kind === 'local-editor'
    ? `Open ${href} in editor`
    : kind === 'local-artifact'
      ? `Open ${href}`
      : undefined;

  const activate = async (): Promise<void> => {
    if (kind === 'local-editor') {
      await useEditorStore.getState().openFile(chatFilePathFromHref(href));
      return;
    }
    if (kind === 'local-artifact') {
      const result = await window.electronAPI.fs.openPath(href, sessionId);
      if (!result.success) throw new Error(result.error || `Could not open ${href}`);
      return;
    }
    await openLinkInAppBrowser(href, sessionId);
  };

  return (
    <a
      href={href}
      target={kind === 'anchor' ? undefined : '_blank'}
      rel={kind === 'anchor' ? undefined : 'noopener noreferrer'}
      onClick={(event) => {
        if (kind === 'anchor') return;
        event.preventDefault();
        event.stopPropagation();
        if (!href) return;
        void activate().catch((error) => {
          console.error(`[Chat] Failed to open link ${href}:`, error);
        });
      }}
      className={`${isLocal ? 'text-cyan-400 hover:text-cyan-300' : 'text-claude-accent'} underline hover:no-underline cursor-pointer`}
      title={title}
    >
      {children}
    </a>
  );
}
