import { ToolId } from '../shared/types';

export interface ToolDefinition {
  id: ToolId;
  label: string;
  emoji: string;
  description: string;
  requiresSelection: boolean;
  requiresDataSources: boolean;
  shortcut: string;
}

export const TOOLS: ToolDefinition[] = [
  {
    id: 'rephrase',
    label: 'Rephrase',
    emoji: '✍️',
    description: 'Rewrite selected text in a different tone',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '1',
  },
  {
    id: 'activity-notes',
    label: 'Activity Notes',
    emoji: '🗓️',
    description: 'Generate a standup or handoff from recent JIRA & GitHub activity',
    requiresSelection: false,
    requiresDataSources: true,
    shortcut: '2',
  },
  {
    id: 'summarizer',
    label: 'Summarize',
    emoji: '📝',
    description: 'TL;DR summary of selected text',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '3',
  },
  {
    id: 'review-polish',
    label: 'Review Polish',
    emoji: '💎',
    description: 'Make code review feedback constructive',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '4',
  },
  {
    id: 'prompt-refiner',
    label: 'Prompt Refiner',
    emoji: '🛠️',
    description: 'Fill in missing pieces and optimize a prompt for an AI agent',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '5',
  },
  {
    id: 'explain-error',
    label: 'Explain Error',
    emoji: '🐛',
    description: 'Find the likely root cause and fix for an error or stack trace',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '6',
  },
  {
    id: 'ask',
    label: 'Ask',
    emoji: '💬',
    description: 'Ask anything in plain English and get a direct answer',
    requiresSelection: true,
    requiresDataSources: false,
    shortcut: '7',
  },
];

export function getToolById(id: ToolId): ToolDefinition | undefined {
  return TOOLS.find((t) => t.id === id);
}
