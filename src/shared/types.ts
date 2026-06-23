export type AIProvider = 'ollama' | 'local-cli' | 'custom';

export type ToneId = 'professional' | 'friendly' | 'direct';

export type ToolId =
  | 'rephrase'
  | 'activity-notes'
  | 'summarizer'
  | 'review-polish'
  | 'prompt-refiner'
  | 'explain-error'
  | 'ask';

export interface TonePrompts {
  professional: string;
  friendly: string;
  direct: string;
}

export interface AppSettings {
  provider: AIProvider;

  // Ollama
  ollamaServerUrl: string;
  ollamaModel: string;

  // Local CLI
  localCliCommand: string;
  localCliTimeoutSecs: number;

  // Custom (OpenAI-compatible / oMLX / Ollama-native)
  customApiEndpoint: string;
  customModel: string;
  customApiKey: string;

  globalShortcut: string;
  autoPaste: boolean;
  tonePrompts: TonePrompts;
  promptRefinerPrompt: string;

  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  githubToken: string;
}

export interface GenerateRequest {
  toolId: ToolId;
  systemPrompt: string;
  userContent: string;
}

export interface ProviderInfo {
  id: AIProvider;
  label: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'ollama', label: 'Ollama' },
  { id: 'local-cli', label: 'Local CLI' },
  { id: 'custom', label: 'Custom' },
];

export interface LocalCliTemplate {
  id: string;
  label: string;
  command: string;
}

/**
 * Presets for the Local CLI "Load Template" dropdown. The prompt is exposed to
 * the command through the `AI_BUDDY_FULL_PROMPT` env var (plus the system/user
 * split via `AI_BUDDY_SYSTEM_PROMPT` / `AI_BUDDY_USER_PROMPT`).
 */
export const LOCAL_CLI_TEMPLATES: LocalCliTemplate[] = [
  {
    id: 'claude',
    label: 'Claude CLI',
    command: 'claude -p "$AI_BUDDY_FULL_PROMPT"',
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    command: 'cursor-agent -p "$AI_BUDDY_FULL_PROMPT"',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex exec "$AI_BUDDY_FULL_PROMPT"',
  },
  {
    id: 'llm',
    label: 'llm (Datasette)',
    command: 'llm -s "$AI_BUDDY_SYSTEM_PROMPT" "$AI_BUDDY_USER_PROMPT"',
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'ollama',

  ollamaServerUrl: 'http://localhost:11434',
  ollamaModel: '',

  localCliCommand: '',
  localCliTimeoutSecs: 45,

  customApiEndpoint: 'http://localhost:11434/api/chat',
  customModel: '',
  customApiKey: '',

  globalShortcut: 'Ctrl+Shift+Space',
  autoPaste: false,
  tonePrompts: {
    professional: '',
    friendly: '',
    direct: '',
  },
  promptRefinerPrompt: '',

  jiraBaseUrl: '',
  jiraEmail: '',
  jiraApiToken: '',
  githubToken: '',
};

export const IPC_CHANNELS = {
  GENERATE_TEXT: 'generate-text',
  GENERATE_TEXT_STREAM: 'generate-text-stream',
  GENERATE_STREAM_CHUNK: 'generate-stream-chunk',
  GET_SETTINGS: 'get-settings',
  SAVE_SETTINGS: 'save-settings',
  CLIPBOARD_TEXT: 'clipboard-text',
  PASTE_RESULT: 'paste-result',
  HIDE_WINDOW: 'hide-window',
  OPEN_EXTERNAL: 'open-external',
  FETCH_JIRA_ACTIVITY: 'fetch-jira-activity',
  FETCH_GITHUB_ACTIVITY: 'fetch-github-activity',
} as const;
