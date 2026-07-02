import { ToneId, TonePrompts } from '../shared/types';

const BASE_INSTRUCTION = `You are a text rewriting assistant. Rewrite the user's message according to the tone instructions below. 
Rules:
- Preserve the original meaning and intent completely.
- Always respond in the exact same language as the input text. Never translate or switch languages.
- Do not add greetings, sign-offs, or extra content unless the original has them.
- Output ONLY the rewritten text, nothing else.`;

export interface ToneDefinition {
  id: ToneId;
  label: string;
  emoji: string;
  shortcut: string;
  /** Optional palette description; falls back to a generated "…tone" line. */
  description?: string;
  /** Optional extra fuzzy-search synonyms. */
  keywords?: string[];
  defaultPrompt: string;
}

export const TONES: ToneDefinition[] = [
  {
    id: 'grammar',
    label: 'Fix Grammar',
    emoji: '✏️',
    shortcut: '1',
    description: 'Fix grammar, spelling & punctuation only — keep everything else',
    keywords: ['grammar', 'spelling', 'punctuation', 'typo', 'correct', 'proofread', 'fix'],
    defaultPrompt: `${BASE_INSTRUCTION}\n\nTask: Fix grammar only. Correct grammar, spelling, and punctuation mistakes. Keep the exact same wording, sentence structure, tone, and formatting — do not rephrase, reorder, or improve style. Change only what is grammatically incorrect. If the text is already correct, return it unchanged.`,
  },
  {
    id: 'natural',
    label: 'Natural',
    emoji: '🗣️',
    shortcut: '2',
    description: 'Sound like a native American English speaker; keep tone & details',
    keywords: ['natural', 'native', 'american', 'fluent', 'idiomatic', 'smooth', 'localize'],
    defaultPrompt: `${BASE_INSTRUCTION}\n\nTask: Make it sound natural. Rewrite so it reads as if written by a native American English speaker — smooth, idiomatic phrasing. Preserve the original tone and every detail; do not add or remove information. Fix only awkward or non-native phrasing while keeping the author's voice.`,
  },
  {
    id: 'professional',
    label: 'Professional',
    emoji: '💼',
    shortcut: '3',
    defaultPrompt: `${BASE_INSTRUCTION}\n\nTone: Professional and business-appropriate. Use clear, polished language suitable for workplace communication. Avoid slang, excessive informality, or overly casual phrasing.`,
  },
  {
    id: 'friendly',
    label: 'Friendly',
    emoji: '😊',
    shortcut: '4',
    defaultPrompt: `${BASE_INSTRUCTION}\n\nTone: Warm, friendly, and approachable. Use conversational language that feels personable and welcoming. It's okay to use light humor or enthusiasm where natural.`,
  },
  {
    id: 'direct',
    label: 'Direct',
    emoji: '🎯',
    shortcut: '5',
    defaultPrompt: `${BASE_INSTRUCTION}\n\nTone: Concise and direct. Remove hedging language, filler words, and unnecessary qualifiers. Get straight to the point while remaining respectful.`,
  },
];

export function resolvePrompt(toneId: ToneId, customPrompts: TonePrompts): string {
  const tone = TONES.find((t) => t.id === toneId);
  if (!tone) throw new Error(`Unknown tone: ${toneId}`);

  const custom = customPrompts[toneId];
  return custom && custom.trim() ? custom : tone.defaultPrompt;
}
