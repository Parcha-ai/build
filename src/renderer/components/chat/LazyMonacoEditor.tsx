import React, { useState, useRef, useEffect } from 'react';
import Editor, { DiffEditor, loader, OnMount } from '@monaco-editor/react';
import type { EditorProps, DiffEditorProps } from '@monaco-editor/react';
import { Code, Loader2 } from 'lucide-react';

// Monaco TextModel disposal error suppression is handled in monaco-config.ts
// which runs earlier in the application lifecycle

// Track all lazy editor instances for cleanup
const lazyEditorModels = new Set<string>();

/**
 * LazyMonacoEditor - Only renders Monaco when visible in viewport
 *
 * Uses IntersectionObserver to detect visibility and renders a lightweight
 * placeholder when scrolled out of view. This dramatically reduces memory
 * usage in long conversations with many tool calls.
 */
interface LazyMonacoEditorProps extends Omit<EditorProps, 'loading'> {
  // Optional: unload Monaco when scrolled this far out of view (in pixels)
  // Default: 500px margin before unloading
  unloadMargin?: number;
  // Unique identifier for this editor instance (for model cleanup)
  editorId?: string;
  // If true, render immediately without waiting for visibility (for recent/active panels)
  priority?: boolean;
}

export function LazyMonacoEditor({
  unloadMargin = 500,
  editorId,
  height = '300px',
  value,
  language,
  priority = false,
  ...props
}: LazyMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Priority panels start visible immediately - no lazy loading delay
  const [isVisible, setIsVisible] = useState(priority);
  const [hasBeenVisible, setHasBeenVisible] = useState(priority);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setIsVisible(visible);
        if (visible) {
          setHasBeenVisible(true);
        }
      },
      {
        // Load when within viewport + margin, unload when far out
        rootMargin: `${unloadMargin}px 0px ${unloadMargin}px 0px`,
        threshold: 0,
      }
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [unloadMargin]);

  // Cleanup model when component unmounts
  useEffect(() => {
    return () => {
      if (editorId) {
        lazyEditorModels.delete(editorId);
      }
    };
  }, [editorId]);

  const handleMount: OnMount = (editor, monaco) => {
    // Track the model for cleanup
    const model = editor.getModel();
    if (model && editorId) {
      lazyEditorModels.add(editorId);
    }

    // Apply custom theme adjustments if needed
    monaco.editor.setTheme('vs-dark');

    // Call original onMount if provided
    if (props.onMount) {
      props.onMount(editor, monaco);
    }
  };

  // Calculate numeric height for placeholder
  const numericHeight = typeof height === 'string'
    ? parseInt(height.replace('px', ''), 10) || 300
    : height;

  // Render placeholder when not visible (and has been visible before, meaning we're unloading)
  // Or when never been visible yet (initial placeholder)
  if (!isVisible) {
    return (
      <div
        ref={containerRef}
        className="bg-claude-bg border border-claude-border flex items-center justify-center"
        style={{
          height: numericHeight,
          borderRadius: 0,
          minHeight: numericHeight,
        }}
      >
        <div className="text-claude-text-secondary text-xs font-mono flex items-center gap-2">
          <Code size={14} />
          <span>{hasBeenVisible ? 'Scroll to view code' : 'Code preview'}</span>
        </div>
      </div>
    );
  }

  // Render actual Monaco editor when visible
  return (
    <div ref={containerRef}>
      <Editor
        height={height}
        value={value}
        language={language}
        theme="vs-dark"
        loading={
          <div
            className="bg-claude-bg flex items-center justify-center text-claude-text-secondary text-xs"
            style={{ height: numericHeight }}
          >
            <Loader2 size={14} className="animate-spin mr-2" />
            Loading editor...
          </div>
        }
        {...props}
        onMount={handleMount}
      />
    </div>
  );
}

/**
 * LazyDiffEditor - Only renders Monaco DiffEditor when visible
 */
interface LazyDiffEditorProps extends Omit<DiffEditorProps, 'loading'> {
  unloadMargin?: number;
  editorId?: string;
  // If true, render immediately without waiting for visibility (for recent/active panels)
  priority?: boolean;
}

export function LazyDiffEditor({
  unloadMargin = 500,
  editorId,
  height = '400px',
  original,
  modified,
  language,
  priority = false,
  ...props
}: LazyDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // Priority panels start visible immediately - no lazy loading delay
  const [isVisible, setIsVisible] = useState(priority);
  const [hasBeenVisible, setHasBeenVisible] = useState(priority);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setIsVisible(visible);
        if (visible) {
          setHasBeenVisible(true);
        }
      },
      {
        rootMargin: `${unloadMargin}px 0px ${unloadMargin}px 0px`,
        threshold: 0,
      }
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [unloadMargin]);

  // Cleanup on unmount - just clear ref, let @monaco-editor/react handle disposal
  // DO NOT manually dispose models - it causes race condition errors
  useEffect(() => {
    return () => {
      editorRef.current = null;
      if (editorId) {
        lazyEditorModels.delete(editorId);
      }
    };
  }, [editorId]);

  // DiffEditor onMount handler - use any for flexibility with monaco-editor types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMount = (editor: any, monaco: any) => {
    editorRef.current = editor;

    if (editorId) {
      lazyEditorModels.add(editorId);
    }

    monaco.editor.setTheme('vs-dark');

    requestAnimationFrame(() => {
      const width = containerRef.current?.clientWidth || 0;
      try {
        if (width > 0) {
          editor.layout({ width, height: boundedHeight });
        } else {
          editor.layout();
        }
      } catch {
        // Ignore first-paint layout races inside virtualized transcript content.
      }
    });

    if (props.onMount) {
      props.onMount(editor, monaco);
    }
  };

  const numericHeight = typeof height === 'string'
    ? parseInt(height.replace('px', ''), 10) || 400
    : height;
  const boundedHeight = Math.min(480, Math.max(80, numericHeight));
  const editorHeight = `${boundedHeight}px`;

  useEffect(() => {
    if (!isVisible || !editorRef.current) return;

    const frame = requestAnimationFrame(() => {
      const width = containerRef.current?.clientWidth || 0;
      try {
        if (width > 0) {
          editorRef.current.layout({ width, height: boundedHeight });
        } else {
          editorRef.current.layout();
        }
      } catch {
        // Monaco can throw during transcript remount races; the next automatic
        // layout tick will recover.
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [boundedHeight, isVisible]);

  // Don't render editor until first visible (lazy load)
  // But once rendered, keep it mounted and just hide with CSS to avoid disposal errors
  if (!hasBeenVisible) {
    return (
      <div
        ref={containerRef}
        className="bg-claude-bg border border-claude-border flex items-center justify-center"
        style={{
          height: boundedHeight,
          borderRadius: 0,
          minHeight: boundedHeight,
          maxHeight: boundedHeight,
          maxWidth: '100%',
          overflow: 'hidden',
        }}
      >
        <div className="text-claude-text-secondary text-xs font-mono flex items-center gap-2">
          <Code size={14} />
          <span>Diff preview</span>
        </div>
      </div>
    );
  }

  // Once mounted, keep the editor alive but hide when not visible
  // This prevents the Monaco disposal race condition errors
  return (
    <div
      ref={containerRef}
      style={{
        height: boundedHeight,
        minHeight: boundedHeight,
        maxHeight: boundedHeight,
        maxWidth: '100%',
        overflow: 'hidden',
        contain: 'layout paint',
      }}
    >
      {!isVisible && (
        <div
          className="bg-claude-bg border border-claude-border flex items-center justify-center"
          style={{
            height: boundedHeight,
            borderRadius: 0,
            minHeight: boundedHeight,
            maxHeight: boundedHeight,
            maxWidth: '100%',
            overflow: 'hidden',
          }}
        >
          <div className="text-claude-text-secondary text-xs font-mono flex items-center gap-2">
            <Code size={14} />
            <span>Scroll to view diff</span>
          </div>
        </div>
      )}
      <div
        style={{
          display: isVisible ? 'block' : 'none',
          height: boundedHeight,
          maxHeight: boundedHeight,
          maxWidth: '100%',
          overflow: 'hidden',
        }}
      >
        <DiffEditor
          height={editorHeight}
          original={original}
          modified={modified}
          language={language}
          theme="vs-dark"
          loading={
            <div
              className="bg-claude-bg flex items-center justify-center text-claude-text-secondary text-xs"
              style={{ height: boundedHeight }}
            >
              <Loader2 size={14} className="animate-spin mr-2" />
              Loading diff editor...
            </div>
          }
          {...props}
          onMount={handleMount}
        />
      </div>
    </div>
  );
}

/**
 * Cleanup function to dispose all lazy editor models
 * Call this when navigating away from long conversations
 */
export async function cleanupLazyEditors() {
  try {
    const monaco = await loader.init();
    const models = monaco.editor.getModels();
    models.forEach((model) => {
      const uri = model.uri.toString();
      if (lazyEditorModels.has(uri)) {
        model.dispose();
        lazyEditorModels.delete(uri);
      }
    });
  } catch (e) {
    // Monaco not initialized
  }
}
