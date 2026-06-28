import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { AIProvider, AppSettings, PROVIDERS, LOCAL_CLI_TEMPLATES } from '../../shared/types';
import { checkOllama, checkCustom, checkOmlx, checkOpenAi } from '../../shared/ai-service';
import { ChevronGlyph, RefreshGlyph } from '../icons';
import CollapsibleSection from './CollapsibleSection';

/** The slice of settings this self-contained form owns. */
export type AiProviderSettings = Pick<
  AppSettings,
  | 'provider'
  | 'omlxServerUrl'
  | 'omlxModel'
  | 'omlxApiKey'
  | 'ollamaServerUrl'
  | 'ollamaModel'
  | 'openaiApiKey'
  | 'openaiModel'
  | 'localCliCommand'
  | 'localCliTimeoutSecs'
  | 'customApiEndpoint'
  | 'customModel'
  | 'customApiKey'
>;

interface AiProviderFormProps {
  /** Initial values. The form keeps its own internal copy after mount. */
  settings: AiProviderSettings;
  /** Persist the given changes. Called automatically (debounced) on edit. */
  onSave: (changes: Partial<AppSettings>) => void;
}

type ConnStatus = 'unknown' | 'checking' | 'connected' | 'disconnected';
type AutoSaveState = 'idle' | 'saving' | 'saved';

/** Channel message shape emitted by the Rust `run_local_cli` command. */
type CliEvent =
  | { event: 'chunk'; data: string }
  | { event: 'done'; data: string }
  | { event: 'error'; data: string };

const STATUS_LABEL: Record<ConnStatus, string> = {
  unknown: 'Not checked',
  checking: 'Checking…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

const pickSlice = (s: AiProviderSettings): AiProviderSettings => ({
  provider: s.provider,
  omlxServerUrl: s.omlxServerUrl,
  omlxModel: s.omlxModel,
  omlxApiKey: s.omlxApiKey,
  ollamaServerUrl: s.ollamaServerUrl,
  ollamaModel: s.ollamaModel,
  openaiApiKey: s.openaiApiKey,
  openaiModel: s.openaiModel,
  localCliCommand: s.localCliCommand,
  localCliTimeoutSecs: s.localCliTimeoutSecs,
  customApiEndpoint: s.customApiEndpoint,
  customModel: s.customModel,
  customApiKey: s.customApiKey,
});

const AUTOSAVE_DELAY_MS = 600;

/**
 * Self-contained AI provider configuration form. Changes are persisted
 * automatically (debounced); there is no manual save button.
 */
export default function AiProviderForm({ settings, onSave }: AiProviderFormProps) {
  const [form, setForm] = useState<AiProviderSettings>(() => pickSlice(settings));
  const [editingServer, setEditingServer] = useState(false);
  const [omlxModels, setOmlxModels] = useState<string[]>([]);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [autoSave, setAutoSave] = useState<AutoSaveState>('idle');
  // Streamed stdout from the last "Test command" run (null = never run yet).
  const [localCliOutput, setLocalCliOutput] = useState<string | null>(null);

  const [status, setStatus] = useState<Record<AIProvider, ConnStatus>>({
    omlx: 'unknown',
    ollama: 'unknown',
    openai: 'unknown',
    'local-cli': 'unknown',
    custom: 'unknown',
  });
  const [errors, setErrors] = useState<Record<AIProvider, string>>({
    omlx: '',
    ollama: '',
    openai: '',
    'local-cli': '',
    custom: '',
  });

  const setProviderStatus = (p: AIProvider, s: ConnStatus, error = '') => {
    setStatus((prev) => ({ ...prev, [p]: s }));
    setErrors((prev) => ({ ...prev, [p]: error }));
  };

  const patch = (changes: Partial<AiProviderSettings>) => {
    setForm((prev) => ({ ...prev, ...changes }));
  };

  // Debounced auto-save: persist the slice shortly after the last edit. The
  // initial mount is skipped so opening the form doesn't trigger a write.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setAutoSave('saving');
    const t = setTimeout(() => {
      onSaveRef.current(form);
      setAutoSave('saved');
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.provider,
    form.omlxServerUrl,
    form.omlxModel,
    form.omlxApiKey,
    form.ollamaServerUrl,
    form.ollamaModel,
    form.openaiApiKey,
    form.openaiModel,
    form.localCliCommand,
    form.localCliTimeoutSecs,
    form.customApiEndpoint,
    form.customModel,
    form.customApiKey,
  ]);

  /** Check connectivity for a provider, update its status, return whether ok. */
  const verifyProvider = useCallback(
    async (p: AIProvider): Promise<boolean> => {
      setProviderStatus(p, 'checking');
      if (p === 'omlx') {
        const result = await checkOmlx(form.omlxServerUrl, form.omlxApiKey);
        if (result.ok) {
          setOmlxModels(result.models);
          if (result.models.length && !form.omlxModel.trim()) {
            patch({ omlxModel: result.models[0] });
          }
          setProviderStatus('omlx', 'connected');
          return true;
        }
        setOmlxModels([]);
        setProviderStatus('omlx', 'disconnected', result.error || 'Connection failed');
        return false;
      }
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
      if (p === 'openai') {
        const result = await checkOpenAi(form.openaiApiKey);
        if (result.ok) {
          setOpenaiModels(result.models);
          // Default to the fastest-responding model (first in the list).
          if (result.models.length && !form.openaiModel.trim()) {
            patch({ openaiModel: result.models[0] });
          }
          setProviderStatus('openai', 'connected');
          return true;
        }
        setOpenaiModels([]);
        setProviderStatus('openai', 'disconnected', result.error || 'Connection failed');
        return false;
      }
      if (p === 'custom') {
        const result = await checkCustom(form.customApiEndpoint, form.customModel, form.customApiKey);
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
      form.omlxServerUrl,
      form.omlxModel,
      form.omlxApiKey,
      form.ollamaServerUrl,
      form.openaiApiKey,
      form.openaiModel,
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

  /**
   * Actually run the Local CLI command with a short test prompt and surface the
   * streamed stdout (or the error) so the user can confirm it works end-to-end,
   * not just that the binary resolves on PATH.
   */
  const handleTestLocalCli = useCallback(async () => {
    if (!form.localCliCommand.trim()) {
      setLocalCliOutput(null);
      setProviderStatus('local-cli', 'disconnected', 'Command is empty');
      return;
    }

    setProviderStatus('local-cli', 'checking');
    setLocalCliOutput('');

    const systemPrompt = "You are AI Buddy's connection test.";
    const userPrompt =
      'Reply in one short line confirming you received this message, and state your ' +
      'model ID, e.g. "Connected — model: <your-model-id>".';
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const channel = new Channel<CliEvent>();
    let full = '';
    let failure: string | null = null;
    channel.onmessage = (msg) => {
      if (msg.event === 'chunk') {
        full += msg.data;
        setLocalCliOutput(full);
      } else if (msg.event === 'error') {
        failure = msg.data;
      }
    };

    try {
      await invoke('run_local_cli', {
        command: form.localCliCommand,
        systemPrompt,
        userPrompt,
        fullPrompt,
        timeoutSecs: form.localCliTimeoutSecs,
        onChunk: channel,
      });
      if (failure) {
        setProviderStatus('local-cli', 'disconnected', failure);
      } else if (!full.trim()) {
        setProviderStatus('local-cli', 'disconnected', 'Command produced no output');
      } else {
        setProviderStatus('local-cli', 'connected');
      }
    } catch (err: any) {
      setProviderStatus('local-cli', 'disconnected', failure ?? (err?.message || String(err)));
    }
  }, [form.localCliCommand, form.localCliTimeoutSecs]);

  const currentStatus = status[form.provider];
  const currentError = errors[form.provider];
  const ollamaConnected = status.ollama === 'connected';
  // Show the current value in the dropdown even if it's not in the fetched list.
  const omlxModelOptions =
    form.omlxModel.trim() && !omlxModels.includes(form.omlxModel.trim())
      ? [form.omlxModel.trim(), ...omlxModels]
      : omlxModels;
  const openaiModelOptions =
    form.openaiModel.trim() && !openaiModels.includes(form.openaiModel.trim())
      ? [form.openaiModel.trim(), ...openaiModels]
      : openaiModels;

  return (
    <CollapsibleSection
      title="AI Provider"
      subtitle="Connection details — saved automatically"
      accessory={
        <span className={`autosave-badge ${autoSave}`}>
          {autoSave === 'saving' ? 'Saving…' : autoSave === 'saved' ? 'Saved' : 'Auto-save'}
        </span>
      }
    >
      <div className="provider-panel">
          <div className="provider-row">
            <span className="provider-row-label">Provider</span>
            <div className="provider-row-control">
              <div className="select-wrap">
                <select
                  className="provider-select"
                  value={form.provider}
                  onChange={(e) => patch({ provider: e.target.value as AIProvider })}
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

          {form.provider === 'omlx' && (
            <div className="provider-config">
              {editingServer ? (
                <div className="config-row">
                  <input
                    type="text"
                    className="config-input"
                    value={form.omlxServerUrl}
                    onChange={(e) => patch({ omlxServerUrl: e.target.value })}
                    placeholder="http://localhost:8000"
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingServer(false)}>
                    Done
                  </button>
                </div>
              ) : (
                <div className="config-row">
                  <span className="config-static">Server: {form.omlxServerUrl}</span>
                  <div className="config-row-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingServer(true)}>
                      Edit
                    </button>
                    <button
                      className="icon-btn small"
                      onClick={() => verifyProvider('omlx')}
                      title="Check connection"
                      aria-label="Check connection"
                      disabled={status.omlx === 'checking'}
                    >
                      <RefreshGlyph />
                    </button>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.omlxApiKey}
                  onChange={(e) => patch({ omlxApiKey: e.target.value })}
                  placeholder="Optional — only if oMLX was started with --api-key"
                />
              </div>

              <div className="form-group">
                <label>Model</label>
                {omlxModelOptions.length > 0 ? (
                  <div className="select-wrap full">
                    <select
                      className="provider-select"
                      value={form.omlxModel}
                      onChange={(e) => patch({ omlxModel: e.target.value })}
                    >
                      {omlxModelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <ChevronGlyph />
                  </div>
                ) : (
                  <input
                    type="text"
                    value={form.omlxModel}
                    onChange={(e) => patch({ omlxModel: e.target.value })}
                    placeholder="Model name (auto-detected when connected)"
                    spellCheck={false}
                  />
                )}
                <span className="hint">Connect to load available models, or type a name manually.</span>
              </div>

              {status.omlx === 'disconnected' && errors.omlx && (
                <span className="hint error-hint">{errors.omlx}</span>
              )}
            </div>
          )}

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

          {form.provider === 'openai' && (
            <div className="provider-config">
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.openaiApiKey}
                  onChange={(e) => patch({ openaiApiKey: e.target.value })}
                  placeholder="sk-…"
                  spellCheck={false}
                />
              </div>

              <div className="form-group">
                <label>Model</label>
                {openaiModelOptions.length > 0 ? (
                  <div className="select-wrap full">
                    <select
                      className="provider-select"
                      value={form.openaiModel}
                      onChange={(e) => patch({ openaiModel: e.target.value })}
                    >
                      {openaiModelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <ChevronGlyph />
                  </div>
                ) : (
                  <input
                    type="text"
                    value={form.openaiModel}
                    onChange={(e) => patch({ openaiModel: e.target.value })}
                    placeholder="Auto-selects the fastest model when connected"
                    spellCheck={false}
                  />
                )}
                <span className="hint">
                  Connect to load your models — the fastest-responding one is selected by default.
                  Models are ordered fastest-first.
                </span>
              </div>

              <div className="form-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => verifyProvider('openai')}
                  disabled={status.openai === 'checking'}
                >
                  {status.openai === 'checking' ? 'Verifying…' : 'Verify connection'}
                </button>
                {status.openai === 'connected' && <span className="saved-indicator">Verified!</span>}
              </div>
              {status.openai === 'disconnected' && errors.openai && (
                <span className="hint error-hint">{errors.openai}</span>
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
                  onClick={handleTestLocalCli}
                  disabled={status['local-cli'] === 'checking'}
                >
                  {status['local-cli'] === 'checking' ? 'Running…' : 'Test command'}
                </button>
              </div>
              {status['local-cli'] === 'disconnected' && errors['local-cli'] && (
                <span className="hint error-hint">{errors['local-cli']}</span>
              )}
              {localCliOutput !== null && localCliOutput.trim() && (
                <div className="cli-test-output">
                  <span className="config-label">
                    {status['local-cli'] === 'checking' ? 'Output (streaming…)' : 'Output'}
                  </span>
                  <pre className="cli-output-pre">{localCliOutput}</pre>
                </div>
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
                  className="btn btn-ghost btn-sm"
                  onClick={() => verifyProvider('custom')}
                  disabled={status.custom === 'checking'}
                >
                  {status.custom === 'checking' ? 'Verifying…' : 'Verify connection'}
                </button>
                {status.custom === 'connected' && <span className="saved-indicator">Verified!</span>}
              </div>
              {status.custom === 'disconnected' && currentError && (
                <span className="hint error-hint">{currentError}</span>
              )}
            </div>
          )}
        </div>
    </CollapsibleSection>
  );
}
