import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AIProvider,
  AppSettings,
  PROVIDERS,
  LOCAL_CLI_TEMPLATES,
  ToneId,
} from '../shared/types';
import { checkOllama, checkCustom } from '../shared/ai-service';
import { TONES } from '../tools/rephrase';
import { DEFAULT_PROMPT_REFINER_PROMPT } from '../tools/prompt-refiner';
import { CloseGlyph } from './icons';

interface SettingsProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onBack: () => void;
  onClose: () => void;
}

type ConnStatus = 'unknown' | 'checking' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<ConnStatus, string> = {
  unknown: 'Not checked',
  checking: 'Checking…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

const PROMPT_PLACEHOLDER = 'Enter your custom prompt…';

const toneDefaultPrompt = (id: ToneId): string =>
  TONES.find((t) => t.id === id)?.defaultPrompt ?? '';

/**
 * Replace empty prompt fields with their defaults so each textarea shows the
 * actual prompt that will be used, ready for the user to edit or replace.
 */
function prefillPromptDefaults(s: AppSettings): AppSettings {
  return {
    ...s,
    tonePrompts: {
      professional: s.tonePrompts.professional.trim()
        ? s.tonePrompts.professional
        : toneDefaultPrompt('professional'),
      friendly: s.tonePrompts.friendly.trim()
        ? s.tonePrompts.friendly
        : toneDefaultPrompt('friendly'),
      direct: s.tonePrompts.direct.trim()
        ? s.tonePrompts.direct
        : toneDefaultPrompt('direct'),
    },
    promptRefinerPrompt: s.promptRefinerPrompt.trim()
      ? s.promptRefinerPrompt
      : DEFAULT_PROMPT_REFINER_PROMPT,
  };
}

/**
 * Collapse a prompt back to '' when it is blank or unchanged from the default.
 * Persisting '' (rather than the default text) keeps users inheriting future
 * updates to the default prompt.
 */
const collapseToDefault = (value: string, def: string): string =>
  value.trim() === '' || value.trim() === def.trim() ? '' : value;

function normalizePromptsForSave(s: AppSettings): AppSettings {
  return {
    ...s,
    tonePrompts: {
      professional: collapseToDefault(s.tonePrompts.professional, toneDefaultPrompt('professional')),
      friendly: collapseToDefault(s.tonePrompts.friendly, toneDefaultPrompt('friendly')),
      direct: collapseToDefault(s.tonePrompts.direct, toneDefaultPrompt('direct')),
    },
    promptRefinerPrompt: collapseToDefault(s.promptRefinerPrompt, DEFAULT_PROMPT_REFINER_PROMPT),
  };
}

export default function Settings({ settings, onSave, onBack, onClose }: SettingsProps) {
  const [form, setForm] = useState<AppSettings>(() => prefillPromptDefaults(settings));
  const [saved, setSaved] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [editingServer, setEditingServer] = useState(false);

  const [status, setStatus] = useState<Record<AIProvider, ConnStatus>>({
    ollama: 'unknown',
    'local-cli': 'unknown',
    custom: 'unknown',
  });
  const [errors, setErrors] = useState<Record<AIProvider, string>>({
    ollama: '',
    'local-cli': '',
    custom: '',
  });

  const setProviderStatus = (p: AIProvider, s: ConnStatus, error = '') => {
    setStatus((prev) => ({ ...prev, [p]: s }));
    setErrors((prev) => ({ ...prev, [p]: error }));
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const patch = (changes: Partial<AppSettings>) => {
    setForm((prev) => ({ ...prev, ...changes }));
    setSaved(false);
  };

  const handleProviderChange = (provider: AIProvider) => {
    patch({ provider });
  };

  /** Check connectivity for a provider, update its status, return whether ok. */
  const verifyProvider = useCallback(
    async (p: AIProvider): Promise<boolean> => {
      setProviderStatus(p, 'checking');
      if (p === 'ollama') {
        const result = await checkOllama(form.ollamaServerUrl);
        if (result.ok) {
          if (result.models.length) patch({ ollamaModel: result.models[0] });
          setProviderStatus('ollama', 'connected');
          return true;
        }
        setProviderStatus('ollama', 'disconnected', result.error || 'Connection failed');
        return false;
      }
      if (p === 'custom') {
        const result = await checkCustom(
          form.customApiEndpoint,
          form.customModel,
          form.customApiKey
        );
        if (result.ok) {
          setProviderStatus('custom', 'connected');
          return true;
        }
        setProviderStatus('custom', 'disconnected', result.error || 'Verification failed');
        return false;
      }
      // local-cli: verify the command's binary resolves on PATH.
      try {
        await invoke('check_local_cli', { command: form.localCliCommand });
        setProviderStatus('local-cli', 'connected');
        return true;
      } catch (err: any) {
        setProviderStatus('local-cli', 'disconnected', err?.message || String(err));
        return false;
      }
    },
    [
      form.ollamaServerUrl,
      form.customApiEndpoint,
      form.customModel,
      form.customApiKey,
      form.localCliCommand,
    ]
  );

  // Auto-check the active provider on open and whenever the provider changes,
  // so a status is always shown without requiring a manual click.
  const verifyRef = useRef(verifyProvider);
  verifyRef.current = verifyProvider;
  useEffect(() => {
    verifyRef.current(form.provider);
  }, [form.provider]);

  const handleVerifyCustom = async () => {
    const ok = await verifyProvider('custom');
    if (ok) {
      const normalized = normalizePromptsForSave(form);
      onSave(normalized);
      setForm(prefillPromptDefaults(normalized));
      setSaved(true);
    }
  };

  const handleTonePromptChange = (toneId: ToneId, value: string) => {
    setForm((prev) => ({
      ...prev,
      tonePrompts: { ...prev.tonePrompts, [toneId]: value },
    }));
    setSaved(false);
  };

  const handleSave = () => {
    const normalized = normalizePromptsForSave(form);
    onSave(normalized);
    setForm(prefillPromptDefaults(normalized));
    setSaved(true);
  };

  const currentStatus = status[form.provider];
  const currentError = errors[form.provider];
  const ollamaConnected = status.ollama === 'connected';

  return (
    <div className="surface settings">
      <div className="topbar drag" data-tauri-drag-region>
        <button className="icon-btn" onClick={onBack} title="Back" aria-label="Back">←</button>
        <span className="topbar-title">Settings</span>
        <span className="topbar-spacer" />
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseGlyph />
        </button>
      </div>

      <div className="settings-content">
        <div className="section-label">AI Provider Integration</div>

        <div className="provider-panel">
          <div className="provider-row">
            <span className="provider-row-label">Provider</span>
            <div className="provider-row-control">
              <div className="select-wrap">
                <select
                  className="provider-select"
                  value={form.provider}
                  onChange={(e) => handleProviderChange(e.target.value as AIProvider)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <ChevronGlyph />
              </div>
              <span className={`conn-status ${currentStatus === 'connected' ? 'connected' : 'disconnected'}`}>
                <span
                  className={`status-dot ${currentStatus === 'connected' ? 'connected' : 'disconnected'}`}
                />
                {STATUS_LABEL[currentStatus]}
              </span>
            </div>
          </div>

          {form.provider === 'ollama' && (
            <div className="provider-config">
              {editingServer ? (
                <div className="config-row">
                  <input
                    type="text"
                    className="config-input"
                    value={form.ollamaServerUrl}
                    onChange={(e) => patch({ ollamaServerUrl: e.target.value })}
                    placeholder="http://localhost:11434"
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingServer(false)}>
                    Done
                  </button>
                </div>
              ) : (
                <div className="config-row">
                  <span className="config-static">Server: {form.ollamaServerUrl}</span>
                  <div className="config-row-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingServer(true)}>
                      Edit
                    </button>
                    <button
                      className="icon-btn small"
                      onClick={() => verifyProvider('ollama')}
                      title="Check connection"
                      aria-label="Check connection"
                      disabled={status.ollama === 'checking'}
                    >
                      <RefreshGlyph />
                    </button>
                  </div>
                </div>
              )}
              {ollamaConnected && form.ollamaModel && (
                <span className="hint">Default model: {form.ollamaModel}</span>
              )}
              {status.ollama === 'disconnected' && errors.ollama && (
                <span className="hint error-hint">{errors.ollama}</span>
              )}
            </div>
          )}

          {form.provider === 'local-cli' && (
            <div className="provider-config">
              <div className="config-head">
                <span className="config-label">Command</span>
                <div className="select-wrap small">
                  <select
                    className="provider-select compact"
                    value=""
                    onChange={(e) => {
                      const tpl = LOCAL_CLI_TEMPLATES.find((t) => t.id === e.target.value);
                      if (tpl) patch({ localCliCommand: tpl.command });
                    }}
                  >
                    <option value="" disabled>
                      Load Template
                    </option>
                    {LOCAL_CLI_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <ChevronGlyph />
                </div>
              </div>
              <textarea
                className="prompt-textarea command-textarea"
                value={form.localCliCommand}
                onChange={(e) => patch({ localCliCommand: e.target.value })}
                placeholder={'e.g. claude -p "$AI_BUDDY_FULL_PROMPT"'}
                rows={4}
                spellCheck={false}
              />
              <span className="hint">
                Prompt is exposed via $AI_BUDDY_FULL_PROMPT, $AI_BUDDY_SYSTEM_PROMPT, and
                $AI_BUDDY_USER_PROMPT.
              </span>

              <div className="config-row timeout-row">
                <span className="config-label">Timeout</span>
                <div className="stepper">
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      patch({ localCliTimeoutSecs: Math.max(5, form.localCliTimeoutSecs - 5) })
                    }
                    aria-label="Decrease timeout"
                  >
                    −
                  </button>
                  <span className="stepper-value">{form.localCliTimeoutSecs}s</span>
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      patch({ localCliTimeoutSecs: Math.min(600, form.localCliTimeoutSecs + 5) })
                    }
                    aria-label="Increase timeout"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="form-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => verifyProvider('local-cli')}
                  disabled={status['local-cli'] === 'checking'}
                >
                  {status['local-cli'] === 'checking' ? 'Checking…' : 'Test command'}
                </button>
              </div>
              {status['local-cli'] === 'disconnected' && errors['local-cli'] && (
                <span className="hint error-hint">{errors['local-cli']}</span>
              )}
            </div>
          )}

          {form.provider === 'custom' && (
            <div className="provider-config">
              <div className="form-group">
                <label>API Endpoint URL</label>
                <input
                  type="text"
                  value={form.customApiEndpoint}
                  onChange={(e) => patch({ customApiEndpoint: e.target.value })}
                  placeholder="http://localhost:11434/api/chat"
                  spellCheck={false}
                />
              </div>
              <div className="form-group">
                <label>Model Name</label>
                <input
                  type="text"
                  value={form.customModel}
                  onChange={(e) => patch({ customModel: e.target.value })}
                  placeholder="qwen3:1.7b"
                  spellCheck={false}
                />
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.customApiKey}
                  onChange={(e) => patch({ customApiKey: e.target.value })}
                  placeholder="Optional"
                />
              </div>
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleVerifyCustom}
                  disabled={status.custom === 'checking'}
                >
                  {status.custom === 'checking' ? 'Verifying…' : 'Verify and Save'}
                </button>
                {status.custom === 'connected' && saved && (
                  <span className="saved-indicator">Verified!</span>
                )}
              </div>
              {status.custom === 'disconnected' && currentError && (
                <span className="hint error-hint">{currentError}</span>
              )}
            </div>
          )}
        </div>

        <div
          className="section-label collapsible"
          onClick={() => toggleSection('integrations')}
        >
          Integrations {expandedSections['integrations'] ? '▾' : '▸'}
        </div>

        {expandedSections['integrations'] && (
          <div className="integration-section">
            <div className="integration-card">
              <div className="integration-name">JIRA</div>
              <div className="form-group">
                <label>Base URL</label>
                <input
                  type="text"
                  value={form.jiraBaseUrl}
                  onChange={(e) => { setForm((prev) => ({ ...prev, jiraBaseUrl: e.target.value })); setSaved(false); }}
                  placeholder="https://your-org.atlassian.net"
                />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input
                  type="text"
                  value={form.jiraEmail}
                  onChange={(e) => { setForm((prev) => ({ ...prev, jiraEmail: e.target.value })); setSaved(false); }}
                  placeholder="you@company.com"
                />
              </div>
              <div className="form-group">
                <label>API Token</label>
                <input
                  type="password"
                  value={form.jiraApiToken}
                  onChange={(e) => { setForm((prev) => ({ ...prev, jiraApiToken: e.target.value })); setSaved(false); }}
                  placeholder="JIRA API token"
                />
              </div>
            </div>

            <div className="integration-card">
              <div className="integration-name">GitHub</div>
              <div className="form-group">
                <label>Personal Access Token</label>
                <input
                  type="password"
                  value={form.githubToken}
                  onChange={(e) => { setForm((prev) => ({ ...prev, githubToken: e.target.value })); setSaved(false); }}
                  placeholder="ghp_..."
                />
              </div>
            </div>
          </div>
        )}

        <div
          className="section-label collapsible"
          onClick={() => toggleSection('tonePrompts')}
        >
          Rephrase Prompts {expandedSections['tonePrompts'] ? '▾' : '▸'}
        </div>

        {expandedSections['tonePrompts'] && (
          <div className="tone-prompts-section">
            {TONES.map((tone) => (
              <div key={tone.id} className="form-group">
                <label>{tone.emoji} {tone.label} Prompt</label>
                <textarea
                  value={form.tonePrompts[tone.id]}
                  onChange={(e) => handleTonePromptChange(tone.id, e.target.value)}
                  placeholder={PROMPT_PLACEHOLDER}
                  rows={4}
                  className="prompt-textarea"
                />
                <span className="hint">Clear and save to restore the default prompt</span>
              </div>
            ))}
          </div>
        )}

        <div
          className="section-label collapsible"
          onClick={() => toggleSection('promptRefiner')}
        >
          Prompt Refiner Prompt {expandedSections['promptRefiner'] ? '▾' : '▸'}
        </div>

        {expandedSections['promptRefiner'] && (
          <div className="tone-prompts-section">
            <div className="form-group">
              <label>🛠️ Prompt Refiner Instructions</label>
              <textarea
                value={form.promptRefinerPrompt}
                onChange={(e) => { setForm((prev) => ({ ...prev, promptRefinerPrompt: e.target.value })); setSaved(false); }}
                placeholder={PROMPT_PLACEHOLDER}
                rows={8}
                className="prompt-textarea"
              />
              <span className="hint">Clear and save to restore the default prompt</span>
            </div>
          </div>
        )}

        <div className="section-label">General</div>

        <div
          className="toggle-row"
          onClick={() => { setForm((prev) => ({ ...prev, autoPaste: !prev.autoPaste })); setSaved(false); }}
          role="switch"
          aria-checked={form.autoPaste}
        >
          <div className="toggle-text">
            <span className="toggle-title">Auto-paste results</span>
            <span className="toggle-desc">Skip the review step — paste straight into your app</span>
          </div>
          <div className={`switch ${form.autoPaste ? 'on' : ''}`}>
            <span className="knob" />
          </div>
        </div>

        <div className="form-group">
          <label>Global Shortcut</label>
          <input
            type="text"
            value={form.globalShortcut}
            onChange={(e) => setForm((prev) => ({ ...prev, globalShortcut: e.target.value }))}
            placeholder="Ctrl+Shift+Space"
          />
          <span className="hint">Applied immediately on save</span>
        </div>

        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave}>
            Save Settings
          </button>
          {saved && <span className="saved-indicator">Saved!</span>}
        </div>
      </div>
    </div>
  );
}

function ChevronGlyph() {
  return (
    <svg className="select-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg className="glyph" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
