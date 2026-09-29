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
    <div className="max-h-[60vh] overflow-y-auto overscroll-contain bg-ink-1 p-4 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.45)]">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2.5">
        <HelpCircle size={15} className="flex-shrink-0 text-amber" />
        <h3 className="text-[13.5px] font-semibold text-fg" style={{ letterSpacing: '-0.01em' }}>
          Question{request.questions.length > 1 ? 's' : ''}
        </h3>
        <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full bg-amber shadow-[0_0_0_3px_rgba(240,180,41,0.18)]" />
      </div>

      {/* Questions */}
      <div className="space-y-5">
        {request.questions.map((question, qIndex) => (
          <div key={qIndex} className="space-y-2">
            {/* Question header chip */}
            <div
              className="inline-block px-[5px] py-px font-mono text-[9.5px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]"
              style={{ letterSpacing: '0.04em' }}
            >
              {question.header}
            </div>

            {/* Question text */}
            <div className="text-[14px] font-medium leading-[1.5] text-fg">{question.question}</div>

            {/* Multi-select hint */}
            {question.multiSelect && (
              <div className="text-[12px] text-fg-5">
                (You can select multiple options)
              </div>
            )}

            {/* Options */}
            <div className="space-y-1.5">
              {question.options.map((option, oIndex) => {
                const isSelected = answers[question.question]?.has(option.label) || false;

                return (
                  <button
                    key={oIndex}
                    onClick={() => handleOptionClick(question, option.label)}
                    className={`
                      w-full text-left px-3 py-2.5 transition-colors
                      ${
                        isSelected
                          ? 'bg-[rgba(76,154,255,0.13)] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]'
                          : 'bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-[#1E1E1E]'
                      }
                    `}
                  >
                    <div className="flex items-start gap-2.5">
                      {/* Checkbox/Radio indicator */}
                      <div
                        className={`
                          flex-shrink-0 w-[14px] h-[14px] mt-[3px] flex items-center justify-center
                          ${
                            isSelected
                              ? 'bg-accent'
                              : 'shadow-[inset_0_0_0_1.5px_#666666]'
                          }
                        `}
                        style={{ borderRadius: question.multiSelect ? 0 : '50%' }}
                      >
                        {isSelected && <Check size={10} strokeWidth={3} className="text-[#0A0A0A]" />}
                      </div>

                      {/* Option content */}
                      <div className="flex-1">
                        <div className={`text-[13px] font-medium ${isSelected ? 'text-accent-text' : 'text-fg'}`}>
                          {option.label}
                        </div>
                        <div className="mt-0.5 text-[12px] leading-[1.5] text-fg-4">
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
      <div className="mt-4 flex items-center justify-end gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex h-[30px] items-center gap-1.5 px-3 text-[12.5px] text-fg-3 transition-colors hover:bg-white/[0.04] hover:text-fg"
          >
            <X size={13} />
            Dismiss
          </button>
        )}
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={`
            flex h-[30px] items-center gap-1.5 px-3 text-[12.5px] font-semibold transition-colors
            ${
              allAnswered
                ? 'bg-[#EDEDED] text-[#0F0F0F] hover:bg-white'
                : 'bg-[#EDEDED] text-[#0F0F0F] cursor-not-allowed opacity-40'
            }
          `}
        >
          <Check size={13} strokeWidth={2.4} />
          Submit
        </button>
      </div>
    </div>
  );
}
