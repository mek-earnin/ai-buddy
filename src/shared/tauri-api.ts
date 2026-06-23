import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { generateText, generateTextStream, AIServiceConfig } from './ai-service';
import { fetchJiraActivity } from './data-sources/jira';
import { fetchGitHubActivity } from './data-sources/github';
import { AppSettings, GenerateRequest } from './types';
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
    openaiApiKey: s.openaiApiKey,
    anthropicApiKey: s.anthropicApiKey,
    openaiModel: s.openaiModel,
    anthropicModel: s.anthropicModel,
  };
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
    return generateText(request.systemPrompt, request.userContent, aiConfig(s));
  },

  generateTextStream: async (request, onChunk) => {
    const s = await ensureSettings();
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
