import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../stores/session.store';

interface SwitcherState {
  isOpen: boolean;
  selectedIndex: number;
  orderedSessionIds: string[];
}

export function useSessionSwitcher() {
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();
  const [state, setState] = useState<SwitcherState>({
    isOpen: false,
    selectedIndex: 0,
    orderedSessionIds: [],
  });

  const ctrlHeldRef = useRef(false);
  const switcherActiveRef = useRef(false);

  // Get sessions ordered by recent activity (MRU order) - only running sessions
  const getOrderedSessions = useCallback(() => {
    return [...sessions]
      .filter(s => s.status === 'running')  // Only active sessions
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(s => s.id);
  }, [sessions]);

  const openSwitcher = useCallback(() => {
    const ordered = getOrderedSessions();
    if (ordered.length <= 1) {
      // Don't open if only one or zero sessions
      return;
    }
    setState({
      isOpen: true,
      // Start at second item (index 1) since current session is first (index 0)
      selectedIndex: 1,
      orderedSessionIds: ordered,
    });
    switcherActiveRef.current = true;
  }, [getOrderedSessions]);

  const closeSwitcher = useCallback((selectCurrent: boolean) => {
    if (selectCurrent && state.isOpen) {
      const selectedId = state.orderedSessionIds[state.selectedIndex];
      if (selectedId && selectedId !== activeSessionId) {
        setActiveSession(selectedId);
      }
    }
    setState(prev => ({ ...prev, isOpen: false }));
    switcherActiveRef.current = false;
  }, [state.isOpen, state.orderedSessionIds, state.selectedIndex, activeSessionId, setActiveSession]);

  const cycleNext = useCallback(() => {
    setState(prev => ({
      ...prev,
      selectedIndex: (prev.selectedIndex + 1) % prev.orderedSessionIds.length,
    }));
  }, []);

  const cyclePrev = useCallback(() => {
    setState(prev => ({
      ...prev,
      selectedIndex: prev.selectedIndex === 0
        ? prev.orderedSessionIds.length - 1
        : prev.selectedIndex - 1,
    }));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Track Ctrl state
      if (e.key === 'Control') {
        ctrlHeldRef.current = true;
      }

      // Ctrl+Tab: Open/cycle switcher
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();

        if (!switcherActiveRef.current) {
          openSwitcher();
        } else {
          if (e.shiftKey) {
            cyclePrev();
          } else {
            cycleNext();
          }
        }
      }

      // Escape: Cancel without switching
      if (e.key === 'Escape' && switcherActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeSwitcher(false);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Ctrl release: Confirm selection and close
      if (e.key === 'Control') {
        ctrlHeldRef.current = false;
        if (switcherActiveRef.current) {
          closeSwitcher(true);
        }
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [openSwitcher, closeSwitcher, cycleNext, cyclePrev]);

  return {
    isOpen: state.isOpen,
    selectedIndex: state.selectedIndex,
    orderedSessionIds: state.orderedSessionIds,
    closeSwitcher,
  };
}
