import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { generateText, generateTextStream, AIServiceConfig, TokenHandler } from './ai-service';
import { fetchJiraActivity } from './data-sources/jira';
import { fetchGitHubActivity } from './data-sources/github';
import { AppSettings, GenerateRequest, UpdateStatus } from './types';
import { AppBridge } from './bridge';

let cachedSettings: AppSettings | null = null;

async function ensureSettings(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings;
  const s = await invoke<AppSettings>('get_settings');
  cachedSettings = s;
  return s;
}

function aiConfig(s: AppSettings): AIServiceConfig {
  return {
    provider: s.provider,
    omlxServerUrl: s.omlxServerUrl,
    omlxModel: s.omlxModel,
    omlxApiKey: s.omlxApiKey,
    ollamaServerUrl: s.ollamaServerUrl,
    ollamaModel: s.ollamaModel,
    openaiApiKey: s.openaiApiKey,
    openaiModel: s.openaiModel,
    customApiEndpoint: s.customApiEndpoint,
    customModel: s.customModel,
    customApiKey: s.customApiKey,
  };
}

/** Channel message shape emitted by the Rust `run_local_cli` command. */
type CliEvent =
  | { event: 'chunk'; data: string }
  | { event: 'done'; data: string }
  | { event: 'error'; data: string };

/**
 * Run the Local CLI provider: spawn the user's command in the Rust backend and
 * stream stdout chunks back through a Tauri Channel.
 */
async function runLocalCli(
  request: GenerateRequest,
  s: AppSettings,
  onToken: TokenHandler
): Promise<string> {
  if (!s.localCliCommand.trim()) {
    throw new Error('Local CLI command not configured. Set it in Settings.');
  }

  const fullPrompt = `${request.systemPrompt}\n\n${request.userContent}`.trim();
  const channel = new Channel<CliEvent>();

  let full = '';
  let failure: string | null = null;
  channel.onmessage = (msg) => {
    if (msg.event === 'chunk') {
      full += msg.data;
      onToken(msg.data);
    } else if (msg.event === 'error') {
      failure = msg.data;
    }
  };

  await invoke('run_local_cli', {
    command: s.localCliCommand,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userContent,
    fullPrompt,
    timeoutSecs: s.localCliTimeoutSecs,
    onChunk: channel,
  });

  if (failure) throw new Error(failure);
  if (!full.trim()) throw new Error('No output from Local CLI command');
  return full.trim();
}

const bridge: AppBridge = {
  getClipboardText: () => invoke('get_clipboard_text'),

  getSettings: async () => {
    const s = await invoke<AppSettings>('get_settings');
    cachedSettings = s;
    return s;
  },

  saveSettings: async (settings) => {
    await invoke('save_settings', { settings });
    cachedSettings = settings;
  },

  generateText: async (request: GenerateRequest) => {
    const s = await ensureSettings();
    if (s.provider === 'local-cli') {
      return runLocalCli(request, s, () => {});
    }
    return generateText(request.systemPrompt, request.userContent, aiConfig(s));
  },

  generateTextStream: async (request, onChunk) => {
    const s = await ensureSettings();
    if (s.provider === 'local-cli') {
      return runLocalCli(request, s, onChunk);
    }
    return generateTextStream(
      request.systemPrompt,
      request.userContent,
      aiConfig(s),
      onChunk
    );
  },

  pasteResult: (text) => invoke('paste_result', { text }),

  hideWindow: () => {
    invoke('hide_window');
  },

  openExternal: (url) => invoke('open_external', { url }),

  fetchJiraActivity: async () => {
    const s = await ensureSettings();
    return fetchJiraActivity({
      baseUrl: s.jiraBaseUrl,
      email: s.jiraEmail,
      apiToken: s.jiraApiToken,
    });
  },

  fetchGitHubActivity: async () => {
    const s = await ensureSettings();
    return fetchGitHubActivity({ token: s.githubToken });
  },

  getAppVersion: () => invoke<string>('app_version'),

  fetchUpdateStatus: () => invoke<UpdateStatus>('fetch_update_status'),

  installUpdate: () => invoke('install_update'),
};

window.aibuddy = bridge;

listen<{ text: string; editable: boolean }>('selected-text', (e) => {
  window.postMessage(
    { channel: 'selected-text', text: e.payload.text, editable: e.payload.editable },
    '*'
  );
});

listen('show-settings', () => {
  window.postMessage({ type: 'show-settings' }, '*');
});
