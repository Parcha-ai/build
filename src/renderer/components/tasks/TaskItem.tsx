import React, { useState, useRef, useEffect } from 'react';
import { X, Square, CheckSquare, Check, Plus, ChevronDown, ChevronRight, Clock3 } from 'lucide-react';
import type { FocusTask } from '../../../shared/types';
import TaskSessionPicker from './TaskSessionPicker';

interface TaskItemProps {
  task: FocusTask;
  isActive: boolean;
  onUpdate: (id: string, updates: Partial<FocusTask>) => void;
  onDelete: (id: string) => void;
  onToggleDone: (id: string) => void;
  onStartPomodoro: (id: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onDeleteSubtask: (taskId: string, subtaskId: string) => void;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (id: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, id: string) => void;
}

export default function TaskItem({
  task,
  isActive,
  onUpdate,
  onDelete,
  onToggleDone,
  onStartPomodoro,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  isDragging,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: TaskItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.title);
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const subtaskInputRef = useRef<HTMLInputElement>(null);
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
    <>
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragEnter={() => onDragEnter(task.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, task.id)}
      className={`group relative h-[22px] flex items-center gap-2 pl-2.5 pr-2 cursor-grab transition-colors ${
        isDragging ? 'opacity-30' : 'hover:bg-claude-surface-hover'
      } ${isDragOver ? 'shadow-[inset_0_2px_0_#4C9AFF]' : ''} ${
        isActive ? 'bg-accent/5 shadow-[inset_2px_0_0_#4C9AFF]' : ''
      }`}
    >
      {/* Checkbox — 14px square */}
      <button
        onClick={() => onToggleDone(task.id)}
        className="flex-shrink-0 flex items-center justify-center transition-colors"
        title={isDone ? 'Mark as not done' : 'Mark as done'}
      >
        {isDone ? (
          <span className="w-3.5 h-3.5 flex items-center justify-center bg-[#333333] text-fg-3">
            <Check size={10} strokeWidth={3} />
          </span>
        ) : (
          <span
            className={`w-3.5 h-3.5 block hover:shadow-[inset_0_0_0_1.5px_#808080] ${
              isActive ? 'shadow-[inset_0_0_0_1.5px_#4C9AFF]' : 'shadow-[inset_0_0_0_1.5px_#4D4D4D]'
            }`}
          />
        )}
      </button>

      {/* Subtask expand toggle */}
      {(task.subtasks?.length || 0) > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowSubtasks(!showSubtasks); }}
          className="flex-shrink-0 text-fg-4 hover:text-fg-2"
        >
          {showSubtasks ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
      )}

      {/* Title */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 h-[18px] bg-transparent text-[12.5px] text-fg focus:outline-none border-b border-accent"
        />
      ) : (
        <span
          onClick={() => setIsEditing(true)}
          title={task.title}
          className={`flex-1 min-w-0 text-[12.5px] leading-[22px] truncate cursor-text ${
            isDone
              ? 'line-through text-fg-5'
              : 'text-fg-2'
          }`}
        >
          {task.title}
          {(task.subtasks?.length || 0) > 0 && (
            <span className="ml-1.5 font-mono text-[10.5px] text-fg-4">
              {(task.subtasks || []).filter(st => st.done).length}/{(task.subtasks || []).length}
            </span>
          )}
        </span>
      )}

      {/* Session link / outside-Build location */}
      <TaskSessionPicker
        selectedSessionId={task.sessionId}
        external={Boolean(task.pomodoroExternal)}
        onSelect={(selection) => onUpdate(task.id, {
          sessionId: selection.external ? undefined : selection.sessionId,
          pomodoroExternal: selection.external,
        })}
      />

      {/* Start a focus slot for this task */}
      {!isDone && (
        <button
          type="button"
          onClick={() => onStartPomodoro(task.id)}
          className={`shrink-0 transition-colors ${
            isActive
              ? 'text-accent'
              : 'hidden group-hover:block text-fg-4 hover:text-fg-2'
          }`}
          title="Start Pomodoro for this task"
        >
          <Clock3 size={10} />
        </button>
      )}

      {/* Add subtask button */}
      <button
        onClick={(e) => { e.stopPropagation(); setAddingSubtask(true); setShowSubtasks(true); }}
        className="flex-shrink-0 hidden group-hover:block text-fg-4 hover:text-fg-2"
        title="Add subtask"
      >
        <Plus size={10} />
      </button>

      {/* Delete button */}
      <button
        onClick={() => onDelete(task.id)}
        className="flex-shrink-0 hidden group-hover:block text-fg-4 hover:text-diff-del"
        title="Delete task"
      >
        <X size={10} />
      </button>
    </div>

    {/* Subtasks */}
    {showSubtasks && (task.subtasks?.length || addingSubtask) && (
      <div className="ml-[17px] border-l border-line pl-2 pb-1">
        {(task.subtasks || []).map(st => (
          <div key={st.id} className="group/sub flex items-center gap-1.5 py-0.5">
            <button
              onClick={() => onToggleSubtask(task.id, st.id)}
              className="flex-shrink-0 text-fg-4 hover:text-fg-2"
            >
              {st.done ? (
                <CheckSquare size={11} className="text-fg-4" />
              ) : (
                <Square size={11} />
              )}
            </button>
            <span className={`text-[11.5px] flex-1 ${st.done ? 'line-through text-fg-5' : 'text-fg-3'}`}>
              {st.title}
            </span>
            <button
              onClick={() => onDeleteSubtask(task.id, st.id)}
              className="opacity-0 group-hover/sub:opacity-100 text-fg-4 hover:text-diff-del"
            >
              <X size={8} />
            </button>
          </div>
        ))}
        {addingSubtask && (
          <input
            ref={subtaskInputRef}
            type="text"
            value={newSubtaskTitle}
            onChange={(e) => setNewSubtaskTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newSubtaskTitle.trim()) {
                onAddSubtask(task.id, newSubtaskTitle.trim());
                setNewSubtaskTitle('');
              } else if (e.key === 'Escape') {
                setAddingSubtask(false);
                setNewSubtaskTitle('');
              }
            }}
            onBlur={() => {
              if (newSubtaskTitle.trim()) {
                onAddSubtask(task.id, newSubtaskTitle.trim());
              }
              setNewSubtaskTitle('');
              setAddingSubtask(false);
            }}
            placeholder="Subtask..."
            className="w-full bg-transparent text-[11.5px] text-fg placeholder:text-fg-5 focus:outline-none border-b border-line focus:border-accent py-0.5"
            autoFocus
          />
        )}
      </div>
    )}
    </>
  );
}
