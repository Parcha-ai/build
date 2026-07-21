import React, { useEffect, useState } from 'react';
import { HelpCircle, Check, X } from 'lucide-react';
import type { Question, QuestionRequest } from '../../../shared/types';

interface QuestionDialogProps {
  request: QuestionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel?: () => void;
}

export default function QuestionDialog({ request, onAnswer, onCancel }: QuestionDialogProps) {
  const createInitialAnswers = () => {
    const initial: Record<string, Set<string>> = {};
    request.questions.forEach((question) => {
      initial[question.question] = new Set();
    });
    return initial;
  };

  // Track selected answers for each question
  const [answers, setAnswers] = useState<Record<string, Set<string>>>(createInitialAnswers);

  useEffect(() => {
    setAnswers(createInitialAnswers());
  }, [request.requestId]);

  const handleOptionClick = (question: Question, optionLabel: string) => {
    setAnswers((prev) => {
      const newAnswers = { ...prev };
      const questionAnswers = new Set(prev[question.question] || []);

      if (question.multiSelect) {
        // Toggle selection for multi-select
        if (questionAnswers.has(optionLabel)) {
          questionAnswers.delete(optionLabel);
        } else {
          questionAnswers.add(optionLabel);
        }
      } else {
        // Single select - replace selection
        questionAnswers.clear();
        questionAnswers.add(optionLabel);
      }

      newAnswers[question.question] = questionAnswers;
      return newAnswers;
    });
  };

  const handleSubmit = () => {
    // Convert Set to comma-separated strings for multi-select
    const formattedAnswers: Record<string, string> = {};
    request.questions.forEach((q) => {
      const selected = Array.from(answers[q.question] || []);
      formattedAnswers[q.question] = selected.join(', ');
    });
    onAnswer(formattedAnswers);
  };

  // Check if all questions have at least one answer
  const allAnswered = request.questions.every((q) => (answers[q.question]?.size || 0) > 0);

  return (
    <div className="border-2 border-blue-500 bg-blue-500/10 p-4 font-mono max-h-[60vh] overflow-y-auto overscroll-contain">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <HelpCircle size={20} className="text-blue-500" />
        <h3 className="text-sm font-bold text-blue-400 uppercase" style={{ letterSpacing: '0.1em' }}>
          QUESTION{request.questions.length > 1 ? 'S' : ''}
        </h3>
      </div>

      {/* Questions */}
      <div className="space-y-4">
        {request.questions.map((question, qIndex) => (
          <div key={qIndex} className="space-y-2">
            {/* Question header chip */}
            <div className="inline-block px-2 py-1 bg-blue-500/20 text-blue-400 text-xs font-bold uppercase border border-blue-500/30">
              {question.header}
            </div>

            {/* Question text */}
            <div className="text-sm text-claude-text font-semibold">{question.question}</div>

            {/* Multi-select hint */}
            {question.multiSelect && (
              <div className="text-xs text-claude-text-secondary italic">
                (You can select multiple options)
              </div>
            )}

            {/* Options */}
            <div className="space-y-2 ml-2">
              {question.options.map((option, oIndex) => {
                const isSelected = answers[question.question]?.has(option.label) || false;

                return (
                  <button
                    key={oIndex}
                    onClick={() => handleOptionClick(question, option.label)}
                    className={`
                      w-full text-left p-3 border transition-colors
                      ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500/20'
                          : 'border-claude-border bg-claude-surface/30 hover:bg-claude-surface/50'
                      }
                    `}
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-start gap-2">
                      {/* Checkbox/Radio indicator */}
                      <div
                        className={`
                          flex-shrink-0 w-4 h-4 mt-0.5 border-2 flex items-center justify-center
                          ${
                            isSelected
                              ? 'border-blue-500 bg-blue-500'
                              : 'border-claude-text-secondary'
                          }
                        `}
                        style={{ borderRadius: question.multiSelect ? 2 : '50%' }}
                      >
                        {isSelected && <Check size={12} className="text-white" />}
                      </div>

                      {/* Option content */}
                      <div className="flex-1">
                        <div className={`text-sm font-semibold ${isSelected ? 'text-blue-400' : 'text-claude-text'}`}>
                          {option.label}
                        </div>
                        <div className="text-xs text-claude-text-secondary mt-1">
                          {option.description}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 mt-4">
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-bold uppercase flex items-center gap-1.5 transition-colors bg-claude-surface text-claude-text-secondary hover:bg-red-900/30 hover:text-red-400"
            style={{ letterSpacing: '0.05em', borderRadius: 0 }}
          >
            <X size={14} />
            DISMISS
          </button>
        )}
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={`
            px-4 py-2 text-xs font-bold uppercase flex items-center gap-1.5 transition-colors
            ${
              allAnswered
                ? 'bg-blue-900/40 text-blue-400 hover:bg-blue-900/60'
                : 'bg-claude-surface text-claude-text-secondary cursor-not-allowed opacity-50'
            }
          `}
          style={{ letterSpacing: '0.05em', borderRadius: 0 }}
        >
          <Check size={14} />
          SUBMIT
        </button>
      </div>
    </div>
  );
}
