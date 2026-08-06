import type { Question, QuestionRequest } from '../../shared/types';

export interface VoiceQuestionResponseInput {
  question_number?: number;
  selections?: unknown;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function optionIndexFromSpokenSelection(selection: string): number | null {
  const value = normalized(selection);
  const ordinalIndexes: Record<string, number> = {
    first: 0, one: 0,
    second: 1, two: 1,
    third: 2, three: 2,
    fourth: 3, four: 3,
    fifth: 4, five: 4,
  };
  if (value in ordinalIndexes) return ordinalIndexes[value];
  const ordinal = value.match(/^(?:the\s+)?(first|second|third|fourth|fifth)(?:\s+(?:one|option|choice))?$/);
  if (ordinal) return ordinalIndexes[ordinal[1]];
  const numeric = value.match(/^(?:option|choice)?\s*([1-9])$/);
  if (numeric) return Number(numeric[1]) - 1;
  const letter = value.match(/^(?:option|choice)?\s*([a-z])$/);
  return letter ? letter[1].charCodeAt(0) - 97 : null;
}

function isRecommendedOption(option: Question['options'][number]): boolean {
  return /\brecommend(?:ed|ation)?\b/i.test(`${option.label} ${option.description}`);
}

export function resolveSpokenQuestionSelection(question: Question, selection: string): string {
  const spoken = normalized(selection);
  if (!spoken) throw new Error('The spoken selection was empty.');

  if (/^(?:the\s+)?recommended(?:\s+(?:one|option|choice))?$/.test(spoken)) {
    const recommended = question.options.find(isRecommendedOption);
    if (recommended) return recommended.label;
    if (question.options[0]) return question.options[0].label;
  }

  const indexed = optionIndexFromSpokenSelection(selection);
  if (indexed !== null && question.options[indexed]) return question.options[indexed].label;

  const exact = question.options.find((option) => normalized(option.label) === spoken);
  if (exact) return exact.label;
  const partialMatches = question.options.filter((option) => {
    const label = normalized(option.label);
    return label.includes(spoken) || spoken.includes(label);
  });
  if (partialMatches.length === 1) return partialMatches[0].label;

  throw new Error(
    `I could not match "${selection}" to ${question.options.map((option, index) => `${String.fromCharCode(65 + index)}: ${option.label}`).join('; ')}.`,
  );
}

export function describePendingQuestion(request: QuestionRequest) {
  return {
    requestId: request.requestId,
    questions: request.questions.map((question, questionIndex) => ({
      questionNumber: questionIndex + 1,
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      options: question.options.map((option, optionIndex) => ({
        option: String.fromCharCode(65 + optionIndex),
        label: option.label,
        description: option.description,
        recommended: isRecommendedOption(option),
      })),
    })),
  };
}

export function resolveVoiceQuestionAnswers(
  request: QuestionRequest,
  responses: VoiceQuestionResponseInput[],
): Record<string, string> {
  const answers: Record<string, string> = {};
  const answeredQuestionIndexes = new Set<number>();

  for (const response of responses) {
    const questionIndex = Number.isInteger(response.question_number)
      ? Number(response.question_number) - 1
      : request.questions.length === 1 ? 0 : -1;
    const question = request.questions[questionIndex];
    if (!question) throw new Error(`Question number ${String(response.question_number || '')} is not pending.`);
    if (answeredQuestionIndexes.has(questionIndex)) throw new Error(`Question ${questionIndex + 1} was answered more than once.`);
    const rawSelections = Array.isArray(response.selections)
      ? response.selections.filter((selection): selection is string => typeof selection === 'string')
      : [];
    if (rawSelections.length === 0) throw new Error(`Question ${questionIndex + 1} needs a selection.`);
    if (!question.multiSelect && rawSelections.length !== 1) {
      throw new Error(`Question ${questionIndex + 1} accepts exactly one selection.`);
    }
    const resolved = rawSelections.map((selection) => resolveSpokenQuestionSelection(question, selection));
    answers[question.question] = [...new Set(resolved)].join(', ');
    answeredQuestionIndexes.add(questionIndex);
  }

  const missing = request.questions.map((_, index) => index).filter((index) => !answeredQuestionIndexes.has(index));
  if (missing.length > 0) {
    throw new Error(`Please answer pending question${missing.length === 1 ? '' : 's'} ${missing.map((index) => index + 1).join(', ')}.`);
  }
  return answers;
}
