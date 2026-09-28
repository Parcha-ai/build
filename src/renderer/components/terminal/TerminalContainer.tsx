import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, Search } from 'lucide-react';
import type { Session } from '../../../shared/types';

interface TerminalContainerProps {
  session: Session;
  compact?: boolean;
}

interface TerminalTab {
  id: string;
  name: string;
}

export default function TerminalContainer({ session, compact }: TerminalContainerProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const terminalRefs = useRef<Map<string, { terminal: Terminal; fitAddon: FitAddon }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const createTerminal = async () => {
    const terminalId = await window.electronAPI.terminal.create(session.id);
    const newTab: TerminalTab = {
      id: terminalId,
      name: `Terminal ${tabs.length + 1}`,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(terminalId);

    // Initialize xterm for this tab after state update
    setTimeout(() => initializeXterm(terminalId), 0);
  };

  const initializeXterm = (terminalId: string) => {
    const container = document.getElementById(`terminal-${terminalId}`);
    if (!container) return;

    const terminal = new Terminal({
      theme: {
        background: '#0A0A0A',
        foreground: '#EDEDED',
        cursor: '#EDEDED',
        cursorAccent: '#0A0A0A',
        selectionBackground: 'rgba(76,154,255,0.32)',
        black: '#0A0A0A',
        brightBlack: '#666666',
        red: '#F85149',
        brightRed: '#FFA198',
        green: '#3FB950',
        brightGreen: '#7EE2A0',
        yellow: '#F0B429',
        brightYellow: '#F5C95C',
        blue: '#4C9AFF',
        brightBlue: '#8DBBFF',
        magenta: '#a855f7',
        brightMagenta: '#c084fc',
        cyan: '#06b6d4',
        brightCyan: '#22d3ee',
        white: '#CFCFCF',
        brightWhite: '#FFFFFF',
      },
      fontFamily: '"Geist Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);

    terminal.open(container);
    fitAddon.fit();

    // Subscribe to terminal output
    const unsubscribe = window.electronAPI.terminal.onOutput(terminalId, (data) => {
      terminal.write(data);
    });

    // Send input to terminal
    terminal.onData((data) => {
      window.electronAPI.terminal.sendInput(terminalId, data);
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.electronAPI.terminal.resize(terminalId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    terminalRefs.current.set(terminalId, { terminal, fitAddon });

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRefs.current.delete(terminalId);
    };
  };

  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // Clean up terminal
    const terminalRef = terminalRefs.current.get(tabId);
    if (terminalRef) {
      terminalRef.terminal.dispose();
      terminalRefs.current.delete(tabId);
    }

    window.electronAPI.terminal.close(tabId);

    setTabs((prev) => prev.filter((t) => t.id !== tabId));

    // Switch to another tab if this was active
    if (activeTabId === tabId) {
      const remaining = tabs.filter((t) => t.id !== tabId);
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  // Create first terminal on mount
  useEffect(() => {
    if (session.status === 'running' && tabs.length === 0) {
      createTerminal();
    }
  }, [session.status]);

  // Fit active terminal on resize
  useEffect(() => {
    if (activeTabId) {
      const terminalRef = terminalRefs.current.get(activeTabId);
      if (terminalRef) {
        setTimeout(() => terminalRef.fitAddon.fit(), 0);
      }
    }
  }, [activeTabId]);

  if (session.status !== 'running') {
    return (
      <div className="h-full flex items-center justify-center bg-ink-term text-fg-4 text-[13px]">
        <p>Start the session to use the terminal</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
      {/* Tab bar */}
      <div className="h-8 flex items-center gap-1 px-1.5 border-b border-white/5 flex-shrink-0">
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`h-6 px-2 flex items-center gap-1.5 text-[11.5px] transition-colors ${
                activeTabId === tab.id
                  ? 'bg-[#262626] text-fg'
                  : 'text-fg-4 hover:text-fg-2'
              }`}
            >
              <span>{tab.name}</span>
              <button
                onClick={(e) => closeTab(tab.id, e)}
                className="p-0.5 text-fg-5 hover:text-fg hover:bg-white/10"
              >
                <X size={12} />
              </button>
            </button>
          ))}
        </div>
        <button
          onClick={createTerminal}
          className="w-6 h-6 flex items-center justify-center text-fg-4 hover:text-fg hover:bg-white/5 transition-colors"
          title="New terminal"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal content */}
      <div ref={containerRef} className="flex-1 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            id={`terminal-${tab.id}`}
            className={`absolute inset-0 p-2 ${
              activeTabId === tab.id ? 'visible' : 'invisible'
            }`}
          />
        ))}

        {tabs.length === 0 && (
          <div className="h-full flex items-center justify-center text-fg-3">
            <button
              onClick={createTerminal}
              className="flex items-center gap-2 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/5 transition-colors"
            >
              <Plus size={16} />
              <span>New Terminal</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
