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

  // Refs to avoid stale closures in event handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const switcherActiveRef = useRef(false);

  const getOrderedSessions = useCallback(() => {
    return [...sessions]
      .filter(s => s.status === 'running' && !s.parentSessionId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(s => s.id);
  }, [sessions]);

  const openSwitcher = useCallback(() => {
    const ordered = getOrderedSessions();
    if (ordered.length <= 1) return;
    const newState: SwitcherState = {
      isOpen: true,
      selectedIndex: 1,
      orderedSessionIds: ordered,
    };
    setState(newState);
    stateRef.current = newState;
    switcherActiveRef.current = true;
  }, [getOrderedSessions]);

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

  const cycleNext = useCallback(() => {
    setState(prev => {
      const next = { ...prev, selectedIndex: (prev.selectedIndex + 1) % prev.orderedSessionIds.length };
      stateRef.current = next;
      return next;
    });
  }, []);

  const cyclePrev = useCallback(() => {
    setState(prev => {
      const next = {
        ...prev,
        selectedIndex: prev.selectedIndex === 0 ? prev.orderedSessionIds.length - 1 : prev.selectedIndex - 1,
      };
      stateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (!switcherActiveRef.current) {
          openSwitcher();
        } else if (e.shiftKey) {
          cyclePrev();
        } else {
          cycleNext();
        }
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

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [openSwitcher, confirmAndClose, cancelAndClose, cycleNext, cyclePrev]);

  return {
    isOpen: state.isOpen,
    selectedIndex: state.selectedIndex,
    orderedSessionIds: state.orderedSessionIds,
    closeSwitcher: cancelAndClose,
  };
}
