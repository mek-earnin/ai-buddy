import React, { useState } from 'react';
import { AIProvider, AppSettings, PROVIDERS, ProviderInfo, ToneId } from '../shared/types';
import { TONES } from '../tools/rephrase';
import { DEFAULT_PROMPT_REFINER_PROMPT } from '../tools/prompt-refiner';
import { CloseGlyph } from './icons';

interface SettingsProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onBack: () => void;
  onClose: () => void;
}

function getApiKeyField(provider: AIProvider): keyof AppSettings {
  switch (provider) {
    case 'openai': return 'openaiApiKey';
    case 'anthropic': return 'anthropicApiKey';
  }
}

function getModelField(provider: AIProvider): keyof AppSettings {
  switch (provider) {
    case 'openai': return 'openaiModel';
    case 'anthropic': return 'anthropicModel';
  }
}

function ProviderCard({
  info,
  apiKey,
  model,
  isActive,
  onActivate,
  onKeyChange,
  onModelChange,
  onConnect,
}: {
  info: ProviderInfo;
  apiKey: string;
  model: string;
  isActive: boolean;
  onActivate: () => void;
  onKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  onConnect: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const isConnected = apiKey.length > 0;

  return (
    <div className={`provider-card ${isActive ? 'active' : ''}`}>
      <div className="provider-header">
        <div className="provider-name-row">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          <span className="provider-name">{info.name}</span>
        </div>
        <div className="provider-status">
          {isConnected ? (
            <span className="status-text connected">Connected</span>
          ) : (
            <span className="status-text disconnected">Not configured</span>
          )}
        </div>
      </div>

      <div className="provider-body">
        <div className="key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onKeyChange(e.target.value)}
            placeholder={info.keyPlaceholder}
            className="key-input"
          />
          <button
            className="icon-btn small"
            onClick={() => setShowKey(!showKey)}
            title={showKey ? 'Hide' : 'Show'}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>

        <div className="model-row">
          <label>Model:</label>
          <input
            type="text"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={info.defaultModel}
            className="model-input"
          />
        </div>
      </div>

      <div className="provider-actions">
        <button className="btn btn-connect" onClick={onConnect}>
          {isConnected ? 'Get New Key' : `Connect to ${info.name}`}
        </button>
        {!isActive && (
          <button className="btn btn-use" onClick={onActivate}>
            Use {info.name}
          </button>
        )}
        {isActive && <span className="active-badge">Active</span>}
      </div>
    </div>
  );
}

export default function Settings({ settings, onSave, onBack, onClose }: SettingsProps) {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleKeyChange = (provider: AIProvider, key: string) => {
    const field = getApiKeyField(provider);
    setForm((prev) => ({ ...prev, [field]: key }));
    setSaved(false);
  };

  const handleModelChange = (provider: AIProvider, model: string) => {
    const field = getModelField(provider);
    setForm((prev) => ({ ...prev, [field]: model }));
    setSaved(false);
  };

  const handleActivate = (provider: AIProvider) => {
    setForm((prev) => ({ ...prev, provider }));
    setSaved(false);
  };

  const handleConnect = (info: ProviderInfo) => {
    window.electronAPI.openExternal(info.dashboardUrl);
  };

  const handleTonePromptChange = (toneId: ToneId, value: string) => {
    setForm((prev) => ({
      ...prev,
      tonePrompts: { ...prev.tonePrompts, [toneId]: value },
    }));
    setSaved(false);
  };

  const handleSave = () => {
    onSave(form);
    setSaved(true);
  };

  return (
    <div className="surface settings">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} title="Back" aria-label="Back">←</button>
        <span className="topbar-title">Settings</span>
        <span className="topbar-spacer" />
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseGlyph />
        </button>
      </div>

      <div className="settings-content">
        <div className="section-label">AI Providers</div>

        {PROVIDERS.map((info) => (
          <ProviderCard
            key={info.id}
            info={info}
            apiKey={form[getApiKeyField(info.id)] as string}
            model={form[getModelField(info.id)] as string}
            isActive={form.provider === info.id}
            onActivate={() => handleActivate(info.id)}
            onKeyChange={(key) => handleKeyChange(info.id, key)}
            onModelChange={(model) => handleModelChange(info.id, model)}
            onConnect={() => handleConnect(info)}
          />
        ))}

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
                  placeholder={tone.defaultPrompt}
                  rows={4}
                  className="prompt-textarea"
                />
                <span className="hint">Leave empty to use the default prompt</span>
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
                placeholder={DEFAULT_PROMPT_REFINER_PROMPT}
                rows={8}
                className="prompt-textarea"
              />
              <span className="hint">Leave empty to use the default prompt</span>
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
            placeholder="Alt+Space"
          />
          <span className="hint">Restart app after changing shortcut</span>
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
