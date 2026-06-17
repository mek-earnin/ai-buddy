import { AppSettings, GenerateRequest } from '../shared/types';
import { ElectronAPI } from '../shared/electron-api';
import { TONES, resolvePrompt } from './rephrase';
import { buildSummarizerPrompt } from './summarizer';
import { buildReviewPolishPrompt } from './review-polish';
import { resolvePromptRefinerPrompt, buildPromptRefinerContent } from './prompt-refiner';
import { buildActivityNotesPrompt, buildActivityNotesContent } from './activity-notes';
import { buildExplainErrorPrompt, buildExplainContent } from './explain';
import { buildAskPrompt, buildAskContent } from './ask';

export type ActionGroup = 'Rephrase' | 'Generate' | 'Tools';

export interface ActionContext {
  /** The text the action operates on (captured selection or typed input). */
  input: string;
  /** A separate user-typed question, used by actions like Ask that treat `input` as context. */
  question?: string;
  settings: AppSettings;
  api: ElectronAPI;
}

export interface Action {
  id: string;
  group: ActionGroup;
  label: string;
  /** Short, plain-language description shown under the label. */
  description: string;
  icon: string;
  /** Extra terms (synonyms) the fuzzy search should match against. */
  keywords: string[];
  /** When true, the action needs text to operate on (selection or typed input). */
  requiresSelection: boolean;
  /** When true, results are never auto-pasted even if the setting is on (the user reviews/copies instead). */
  disableAutoPaste?: boolean;
  /** Builds the request sent to the AI service, fetching any extra data it needs. */
  buildRequest: (ctx: ActionContext) => Promise<GenerateRequest>;
}

const REPHRASE_ACTIONS: Action[] = TONES.map((tone) => ({
  id: `rephrase:${tone.id}`,
  group: 'Rephrase',
  label: tone.label,
  description: `Rewrite the selected text in a ${tone.label.toLowerCase()} tone`,
  icon: tone.emoji,
  keywords: ['rephrase', 'rewrite', 'tone', 'reword', tone.id, tone.label],
  requiresSelection: true,
  buildRequest: async ({ input, settings }) => ({
    toolId: 'rephrase',
    systemPrompt: resolvePrompt(tone.id, settings.tonePrompts),
    userContent: input,
  }),
}));

const TOOL_ACTIONS: Action[] = [
  {
    id: 'summarizer',
    group: 'Tools',
    label: 'Summarize',
    description: 'Condense the selected text into a short TL;DR',
    icon: '📝',
    keywords: ['summary', 'summarize', 'tldr', 'shorten', 'digest', 'recap'],
    requiresSelection: true,
    disableAutoPaste: true,
    buildRequest: async ({ input }) => ({
      toolId: 'summarizer',
      systemPrompt: buildSummarizerPrompt(),
      userContent: input,
    }),
  },
  {
    id: 'review-polish',
    group: 'Tools',
    label: 'Review Polish',
    description: 'Make code review feedback constructive and actionable',
    icon: '💎',
    keywords: ['review', 'polish', 'feedback', 'comment', 'pr', 'constructive'],
    requiresSelection: true,
    buildRequest: async ({ input }) => ({
      toolId: 'review-polish',
      systemPrompt: buildReviewPolishPrompt(),
      userContent: input,
    }),
  },
  {
    id: 'prompt-refiner',
    group: 'Tools',
    label: 'Prompt Refiner',
    description: 'Fill in missing pieces and optimize a prompt for an AI agent',
    icon: '🛠️',
    keywords: ['prompt', 'refine', 'optimize', 'agent', 'improve', 'rewrite', 'engineer'],
    requiresSelection: true,
    buildRequest: async ({ input, settings }) => ({
      toolId: 'prompt-refiner',
      systemPrompt: resolvePromptRefinerPrompt(settings.promptRefinerPrompt),
      userContent: buildPromptRefinerContent(input),
    }),
  },
  {
    id: 'explain-error',
    group: 'Tools',
    label: 'Explain Error',
    description: 'Find the likely root cause and fix for an error or stack trace',
    icon: '🐛',
    keywords: ['error', 'debug', 'stack trace', 'traceback', 'exception', 'crash', 'fix', 'why'],
    requiresSelection: true,
    disableAutoPaste: true,
    buildRequest: async ({ input }) => ({
      toolId: 'explain-error',
      systemPrompt: buildExplainErrorPrompt(),
      userContent: buildExplainContent(input),
    }),
  },
];

const GENERATE_ACTIONS: Action[] = [
  {
    id: 'ask',
    group: 'Generate',
    label: 'Ask',
    description: 'Ask anything in plain English and get a direct answer',
    icon: '💬',
    keywords: ['ask', 'question', 'answer', 'help', 'chat', 'how', 'what', 'why', 'assistant', 'anything'],
    requiresSelection: false,
    disableAutoPaste: true,
    buildRequest: async ({ input, question }) => ({
      toolId: 'ask',
      systemPrompt: buildAskPrompt(),
      userContent: buildAskContent(question ?? '', input),
    }),
  },
  {
    id: 'activity-notes',
    group: 'Generate',
    label: 'Activity Notes',
    description: 'Draft a standup or handoff from your recent JIRA & GitHub activity',
    icon: '🗓️',
    keywords: [
      'standup',
      'daily',
      'scrum',
      'handoff',
      'handover',
      'shift',
      'update',
      'notes',
      'jira',
      'github',
    ],
    requiresSelection: false,
    buildRequest: async ({ input, api }) => {
      const [jira, github] = await Promise.all([
        api.fetchJiraActivity().catch(() => null),
        api.fetchGitHubActivity().catch(() => null),
      ]);
      return {
        toolId: 'activity-notes',
        systemPrompt: buildActivityNotesPrompt(),
        userContent: buildActivityNotesContent(jira, github, input),
      };
    },
  },
];

/** All actions in display order (used when the search query is empty). */
export const ACTIONS: Action[] = [
  ...REPHRASE_ACTIONS,
  ...GENERATE_ACTIONS,
  ...TOOL_ACTIONS,
];

export const GROUP_ORDER: ActionGroup[] = ['Rephrase', 'Generate', 'Tools'];

export function getActionById(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/** A contiguous run of characters; `match` marks fuzzy-matched substrings. */
export interface MatchSegment {
  text: string;
  match: boolean;
}

export interface ScoredAction {
  action: Action;
  score: number;
  /** Highlighted segments of the label for the current query. */
  segments: MatchSegment[];
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) and the matched
 * character indices within `text`, or null when `query` is not a subsequence.
 * Rewards consecutive matches and matches at word boundaries so that typing
 * "fr" ranks "Friendly" above an incidental match elsewhere.
 */
function fuzzyMatch(text: string, query: string): { score: number; indices: number[] } | null {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const indices: number[] = [];

  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      indices.push(i);
      let charScore = 1;
      if (i === prevMatchIdx + 1) charScore += 5; // consecutive run
      if (i === 0 || /[\s\-_/]/.test(lowerText[i - 1])) charScore += 8; // word boundary
      score += charScore;
      prevMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx < lowerQuery.length) return null;

  // Prefer shorter targets and earlier first matches.
  score -= lowerText.length * 0.1;
  score -= indices[0] * 0.5;
  return { score, indices };
}

function buildSegments(text: string, indices: number[]): MatchSegment[] {
  if (indices.length === 0) return [{ text, match: false }];
  const matchSet = new Set(indices);
  const segments: MatchSegment[] = [];
  let buffer = '';
  let bufferMatch = matchSet.has(0);

  for (let i = 0; i < text.length; i++) {
    const isMatch = matchSet.has(i);
    if (isMatch === bufferMatch) {
      buffer += text[i];
    } else {
      if (buffer) segments.push({ text: buffer, match: bufferMatch });
      buffer = text[i];
      bufferMatch = isMatch;
    }
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch });
  return segments;
}

/**
 * Filters and ranks actions for a query. An empty query returns every action in
 * its natural order. A query matches against the label (highlighted), the
 * description, and keyword synonyms.
 */
export function searchActions(query: string): ScoredAction[] {
  const trimmed = query.trim();

  if (!trimmed) {
    return ACTIONS.map((action) => ({
      action,
      score: 0,
      segments: [{ text: action.label, match: false }],
    }));
  }

  const scored: ScoredAction[] = [];

  for (const action of ACTIONS) {
    const labelMatch = fuzzyMatch(action.label, trimmed);

    let bestExtra = 0;
    let matched = labelMatch !== null;
    const haystacks = [action.description, ...action.keywords];
    for (const hay of haystacks) {
      const m = fuzzyMatch(hay, trimmed);
      if (m) {
        matched = true;
        // Keyword/description matches count, but rank below direct label hits.
        bestExtra = Math.max(bestExtra, m.score * 0.4);
      }
    }

    if (!matched) continue;

    const labelScore = labelMatch ? labelMatch.score : 0;
    scored.push({
      action,
      score: labelScore + bestExtra,
      segments: labelMatch
        ? buildSegments(action.label, labelMatch.indices)
        : [{ text: action.label, match: false }],
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}
