import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { FocusTask, FocusSubtask } from '../../shared/types';

interface TaskState {
  tasks: FocusTask[];
  focusModeEnabled: boolean;
  activeTaskId: string | null;
  isLoaded: boolean;

  loadTasks: () => Promise<void>;
  addTask: (title: string) => Promise<void>;
  updateTask: (id: string, updates: Partial<FocusTask>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  reorderTasks: (reordered: FocusTask[]) => Promise<void>;
  setTasks: (tasks: FocusTask[]) => Promise<void>;
  toggleFocusMode: () => Promise<void>;
  markTaskDone: (id: string) => Promise<void>;
  addSubtask: (taskId: string, title: string) => Promise<void>;
  toggleSubtask: (taskId: string, subtaskId: string) => Promise<void>;
  deleteSubtask: (taskId: string, subtaskId: string) => Promise<void>;
}

const persistTasks = async (tasks: FocusTask[], extras?: Record<string, unknown>) => {
  await window.electronAPI.settings.set({
    focusTasks: tasks,
    ...extras,
  });
};

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  focusModeEnabled: false,
  activeTaskId: null,
  isLoaded: false,

  loadTasks: async () => {
    const settings = await window.electronAPI.settings.get();
    set({
      tasks: (settings as any).focusTasks || [],
      focusModeEnabled: (settings as any).focusModeEnabled || false,
      activeTaskId: (settings as any).focusModeActiveTaskId || null,
      isLoaded: true,
    });
  },

  addTask: async (title) => {
    const tasks = [...get().tasks];
    const newTask: FocusTask = {
      id: uuid(),
      title,
      order: tasks.length,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    tasks.push(newTask);
    set({ tasks });
    await persistTasks(tasks);
  },

  updateTask: async (id, updates) => {
    const tasks = get().tasks.map(t => t.id === id ? { ...t, ...updates } : t);
    set({ tasks });
    await persistTasks(tasks);
  },

  deleteTask: async (id) => {
    const tasks = get().tasks.filter(t => t.id !== id);
    // Recompute order
    tasks.forEach((t, i) => t.order = i);
    set({ tasks });
    await persistTasks(tasks);
  },

  reorderTasks: async (reordered) => {
    reordered.forEach((t, i) => t.order = i);
    set({ tasks: reordered });
    await persistTasks(reordered);
  },

  setTasks: async (tasks) => {
    tasks.forEach((t, i) => t.order = i);
    set({ tasks });
    await persistTasks(tasks);
  },

  toggleFocusMode: async () => {
    const { focusModeEnabled, tasks } = get();
    const newEnabled = !focusModeEnabled;

    if (newEnabled) {
      // Find first incomplete task (by order), with or without a session
      const sorted = [...tasks].sort((a, b) => a.order - b.order);
      const firstIncomplete = sorted.find(t => t.status !== 'done');
      if (firstIncomplete) {
        const activeId = firstIncomplete.id;
        const updated = tasks.map(t =>
          t.id === activeId ? { ...t, status: 'active' as const } : t
        );
        set({ tasks: updated, focusModeEnabled: true, activeTaskId: activeId });
        await persistTasks(updated, { focusModeEnabled: true, focusModeActiveTaskId: activeId });

        // Switch to the task's linked session if it has one
        if (firstIncomplete.sessionId) {
          const { useSessionStore } = await import('./session.store');
          useSessionStore.getState().setActiveSession(firstIncomplete.sessionId);
        }
        return;
      }
    }

    // Disable focus mode — reset all active tasks back to pending
    const updated = tasks.map(t =>
      t.status === 'active' ? { ...t, status: 'pending' as const } : t
    );
    set({ tasks: updated, focusModeEnabled: false, activeTaskId: null });
    await persistTasks(updated, { focusModeEnabled: false, focusModeActiveTaskId: undefined });
  },

  markTaskDone: async (id) => {
    const { tasks, focusModeEnabled } = get();
    const updated = tasks.map(t =>
      t.id === id ? { ...t, status: 'done' as const, completedAt: new Date().toISOString() } : t
    );

    // Find next pending task with a session
    let nextActiveId: string | null = null;
    if (focusModeEnabled) {
      const next = updated.find(t => t.status === 'pending' && t.sessionId);
      if (next) {
        nextActiveId = next.id;
        const withNext = updated.map(t =>
          t.id === next.id ? { ...t, status: 'active' as const } : t
        );
        set({ tasks: withNext, activeTaskId: nextActiveId });
        await persistTasks(withNext, { focusModeActiveTaskId: nextActiveId });
        return;
      }
      // All done - disable focus mode
      set({ tasks: updated, focusModeEnabled: false, activeTaskId: null });
      await persistTasks(updated, { focusModeEnabled: false, focusModeActiveTaskId: null });
      return;
    }

    set({ tasks: updated });
    await persistTasks(updated);
  },

  addSubtask: async (taskId, title) => {
    const tasks = get().tasks.map(t => {
      if (t.id !== taskId) return t;
      const subtask: FocusSubtask = { id: uuid(), title, done: false };
      return { ...t, subtasks: [...(t.subtasks || []), subtask] };
    });
    set({ tasks });
    await persistTasks(tasks);
  },

  toggleSubtask: async (taskId, subtaskId) => {
    const tasks = get().tasks.map(t => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        subtasks: (t.subtasks || []).map(st =>
          st.id === subtaskId ? { ...st, done: !st.done } : st
        ),
      };
    });
    set({ tasks });
    await persistTasks(tasks);
  },

  deleteSubtask: async (taskId, subtaskId) => {
    const tasks = get().tasks.map(t => {
      if (t.id !== taskId) return t;
      return { ...t, subtasks: (t.subtasks || []).filter(st => st.id !== subtaskId) };
    });
    set({ tasks });
    await persistTasks(tasks);
  },
}));
