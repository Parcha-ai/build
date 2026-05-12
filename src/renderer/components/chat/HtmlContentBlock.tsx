import React, { useRef, useEffect, useState, useMemo } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';

interface HtmlContentBlockProps {
  html: string;
  messageId: string;
}

export default function HtmlContentBlock({ html, messageId }: HtmlContentBlockProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  const [copied, setCopied] = useState(false);
  const frameId = useMemo(() => `html-frame-${messageId}-${Date.now()}`, [messageId]);

  // Inject resize observer script into the HTML
  const enhancedHtml = useMemo(() => {
    const resizeScript = `
      <script>
        (function() {
          var frameId = '${frameId}';
          function reportHeight() {
            var h = Math.max(
              document.body.scrollHeight,
              document.body.offsetHeight,
              document.documentElement.scrollHeight
            );
            window.parent.postMessage({ type: 'iframe-resize', frameId: frameId, height: h }, '*');
          }
          new ResizeObserver(reportHeight).observe(document.body);
          window.addEventListener('load', reportHeight);
          reportHeight();
        })();
      </script>
    `;
    // Insert before closing </body> or append
    if (html.includes('</body>')) {
      return html.replace('</body>', resizeScript + '</body>');
    }
    return html + resizeScript;
  }, [html, frameId]);

  // Listen for resize messages
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'iframe-resize' && e.data?.frameId === frameId) {
        const newHeight = Math.max(200, Math.min(2000, e.data.height));
        setHeight(newHeight);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [frameId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: silent failure
    }
  };

  const handleOpenInBrowser = () => {
    try {
      const encoded = btoa(unescape(encodeURIComponent(html)));
      const dataUri = `data:text/html;base64,${encoded}`;
      window.electronAPI.app.openExternal(dataUri);
    } catch {
      // Fallback: silent failure
    }
  };

  return (
    <div className="relative group my-2">
      <iframe
        ref={iframeRef}
        srcDoc={enhancedHtml}
        sandbox="allow-scripts"
        className="w-full border border-claude-border bg-[#1a1a2e]"
        style={{ height, borderRadius: 0, minHeight: 200, maxHeight: 2000 }}
        title="HTML Response"
      />
      {/* Action bar - appears on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleOpenInBrowser}
          className="p-1.5 bg-claude-surface/90 border border-claude-border text-claude-text-secondary hover:text-claude-text"
          style={{ borderRadius: 0 }}
          title="Open in browser"
        >
          <ExternalLink size={14} />
        </button>
        <button
          onClick={handleCopy}
          className="p-1.5 bg-claude-surface/90 border border-claude-border text-claude-text-secondary hover:text-claude-text"
          style={{ borderRadius: 0 }}
          title="Copy HTML"
        >
          {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
