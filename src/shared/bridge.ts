import { AppSettings, GenerateRequest, UpdateStatus } from './types';
import { JiraActivity } from './data-sources/jira';
import { GitHubActivity } from './data-sources/github';

export interface AppBridge {
  getClipboardText: () => Promise<string>;
  generateText: (request: GenerateRequest) => Promise<string>;
  generateTextStream: (
    request: GenerateRequest,
    onChunk: (delta: string) => void
  ) => Promise<string>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  pasteResult: (text: string) => Promise<void>;
  hideWindow: () => void;
  openExternal: (url: string) => Promise<void>;
  fetchJiraActivity: () => Promise<JiraActivity>;
  fetchGitHubActivity: () => Promise<GitHubActivity>;
  getAppVersion: () => Promise<string>;
  fetchUpdateStatus: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<void>;
}

declare global {
  interface Window {
    aibuddy: AppBridge;
  }
}
