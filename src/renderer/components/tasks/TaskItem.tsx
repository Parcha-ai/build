import React, { useState, useRef, useEffect } from 'react';
import { GripVertical, X, Square, CheckSquare, Link2, Unlink } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import type { FocusTask } from '../../../shared/types';

interface TaskItemProps {
  task: FocusTask;
  isActive: boolean;
  onUpdate: (id: string, updates: Partial<FocusTask>) => void;
  onDelete: (id: string) => void;
  onToggleDone: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
}

export default function TaskItem({
  task,
  isActive,
  onUpdate,
  onDelete,
  onToggleDone,
  onDragStart,
  onDragOver,
  onDrop,
}: TaskItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.title);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);

  // Close session picker on outside click
  useEffect(() => {
    if (!showSessionPicker) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSessionPicker]);

  const linkedSession = task.sessionId ? sessions.find(s => s.id === task.sessionId) : null;
  // Sessions available to link (exclude forks)
  const linkableSessions = sessions.filter(s => !s.parentSessionId);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    } else {
      setEditValue(task.title);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setEditValue(task.title);
      setIsEditing(false);
    }
  };

  const isDone = task.status === 'done';

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, task.id)}
      className={`group flex items-center gap-1.5 px-2 py-1 hover:bg-claude-surface-hover transition-colors ${
        isActive ? 'border-l-2 border-green-500 bg-green-500/5' : 'border-l-2 border-transparent'
      }`}
    >
      {/* Drag handle */}
      <div className="cursor-grab opacity-0 group-hover:opacity-40 transition-opacity flex-shrink-0">
        <GripVertical size={10} className="text-claude-text-secondary" />
      </div>

      {/* Checkbox */}
      <button
        onClick={() => onToggleDone(task.id)}
        className="flex-shrink-0 text-claude-text-secondary hover:text-claude-text transition-colors"
      >
        {isDone ? (
          <CheckSquare size={12} className="text-green-500" />
        ) : (
          <Square size={12} />
        )}
      </button>

      {/* Title */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-claude-text focus:outline-none border-b border-claude-accent"
        />
      ) : (
        <span
          onClick={() => setIsEditing(true)}
          className={`flex-1 min-w-0 text-[11px] font-mono break-words cursor-text ${
            isDone
              ? 'line-through text-claude-text-secondary/50'
              : 'text-claude-text'
          }`}
        >
          {task.title}
        </span>
      )}

      {/* Session link indicator / button */}
      <div className="relative flex-shrink-0" ref={pickerRef}>
        {linkedSession ? (
          <button
            onClick={() => setShowSessionPicker(!showSessionPicker)}
            className="opacity-60 group-hover:opacity-100 transition-opacity text-cyan-400 hover:text-cyan-300"
            title={`Linked: ${linkedSession.name}`}
          >
            <Link2 size={10} />
          </button>
        ) : (
          <button
            onClick={() => setShowSessionPicker(!showSessionPicker)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-claude-text-secondary hover:text-cyan-400"
            title="Link to session"
          >
            <Link2 size={10} />
          </button>
        )}

        {/* Session picker dropdown */}
        {showSessionPicker && (
          <div className="absolute right-0 top-5 z-50 w-56 max-h-48 overflow-y-auto bg-claude-surface border border-claude-border shadow-lg">
            {linkedSession && (
              <button
                onClick={() => {
                  onUpdate(task.id, { sessionId: undefined });
                  setShowSessionPicker(false);
                }}
                className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-red-400 hover:bg-claude-bg flex items-center gap-1.5"
              >
                <Unlink size={9} />
                Unlink session
              </button>
            )}
            <div className="border-t border-claude-border" />
            {linkableSessions.map(s => (
              <button
                key={s.id}
                onClick={() => {
                  onUpdate(task.id, { sessionId: s.id });
                  setShowSessionPicker(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-claude-bg truncate ${
                  s.id === task.sessionId ? 'text-cyan-400' : 'text-claude-text'
                }`}
              >
                {s.name}
              </button>
            ))}
            {linkableSessions.length === 0 && (
              <div className="px-3 py-2 text-[9px] font-mono text-claude-text-secondary">
                No sessions available
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={() => onDelete(task.id)}
        className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-claude-text-secondary hover:text-red-400"
      >
        <X size={10} />
      </button>
    </div>
  );
}
