import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../stores/session.store';

interface SwitcherState {
  isOpen: boolean;
  selectedIndex: number;
  orderedSessionIds: string[];
}

export function useSessionSwitcher() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const [state, setState] = useState<SwitcherState>({
    isOpen: false,
    selectedIndex: 0,
    orderedSessionIds: [],
  });

  const stateRef = useRef(state);
  stateRef.current = state;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const switcherActiveRef = useRef(false);

  const getOrderedSessions = useCallback(() => {
    return [...sessions]
      .filter(s => s.status === 'running')
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(s => s.id);
  }, [sessions]);

  // Core actions — used by both native keyboard and IPC paths
  const doOpen = useCallback(() => {
    const ordered = getOrderedSessions();
    if (ordered.length <= 1) return;
    const newState: SwitcherState = { isOpen: true, selectedIndex: 1, orderedSessionIds: ordered };
    setState(newState);
    stateRef.current = newState;
    switcherActiveRef.current = true;
  }, [getOrderedSessions]);

  const doCycle = useCallback((direction: 'next' | 'prev') => {
    setState(prev => {
      const len = prev.orderedSessionIds.length;
      const next = {
        ...prev,
        selectedIndex: direction === 'next'
          ? (prev.selectedIndex + 1) % len
          : (prev.selectedIndex === 0 ? len - 1 : prev.selectedIndex - 1),
      };
      stateRef.current = next;
      return next;
    });
  }, []);

  const confirmAndClose = useCallback(() => {
    const s = stateRef.current;
    if (s.isOpen) {
      const selectedId = s.orderedSessionIds[s.selectedIndex];
      if (selectedId && selectedId !== activeSessionIdRef.current) {
        setActiveSession(selectedId);
      }
    }
    const closed: SwitcherState = { isOpen: false, selectedIndex: 0, orderedSessionIds: [] };
    setState(closed);
    stateRef.current = closed;
    switcherActiveRef.current = false;
  }, [setActiveSession]);

  const cancelAndClose = useCallback(() => {
    const closed: SwitcherState = { isOpen: false, selectedIndex: 0, orderedSessionIds: [] };
    setState(closed);
    stateRef.current = closed;
    switcherActiveRef.current = false;
  }, []);

  useEffect(() => {
    // Native keyboard — works when renderer (chat/sidebar) has focus
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (!switcherActiveRef.current) doOpen();
        else doCycle(e.shiftKey ? 'prev' : 'next');
      }
      if (e.key === 'Escape' && switcherActiveRef.current) {
        e.preventDefault();
        cancelAndClose();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' && switcherActiveRef.current) {
        confirmAndClose();
      }
    };

    // IPC from main process — works when webview has focus
    // (webview's before-input-event forwards Ctrl+Tab/Ctrl release)
    const ipcUnsub = (window as any).electronAPI?.app?.onSessionSwitcher?.((data: { action: string }) => {
      if (data.action === 'next' || data.action === 'prev') {
        if (!switcherActiveRef.current) doOpen();
        else doCycle(data.action);
      } else if (data.action === 'confirm') {
        if (switcherActiveRef.current) confirmAndClose();
      }
    });

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      ipcUnsub?.();
    };
  }, [doOpen, doCycle, confirmAndClose, cancelAndClose]);

  return {
    isOpen: state.isOpen,
    selectedIndex: state.selectedIndex,
    orderedSessionIds: state.orderedSessionIds,
    closeSwitcher: cancelAndClose,
  };
}
