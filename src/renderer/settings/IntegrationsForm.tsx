import React, { useState } from 'react';
import { AppSettings } from '../../shared/types';
import CollapsibleSection from './CollapsibleSection';

/** The slice of settings this self-contained form owns. */
export type IntegrationsSettings = Pick<
  AppSettings,
  'jiraBaseUrl' | 'jiraEmail' | 'jiraApiToken' | 'githubToken'
>;

interface IntegrationsFormProps {
  /** Initial values. The form keeps its own internal copy after mount. */
  settings: IntegrationsSettings;
  /** Persist the given changes. Called when the user clicks Save. */
  onSave: (changes: Partial<AppSettings>) => void;
}

const pickSlice = (s: IntegrationsSettings): IntegrationsSettings => ({
  jiraBaseUrl: s.jiraBaseUrl,
  jiraEmail: s.jiraEmail,
  jiraApiToken: s.jiraApiToken,
  githubToken: s.githubToken,
});

/**
 * Self-contained integrations form: external account credentials (JIRA,
 * GitHub). Edits are held locally and persisted on Save.
 */
export default function IntegrationsForm({ settings, onSave }: IntegrationsFormProps) {
  const [form, setForm] = useState<IntegrationsSettings>(() => pickSlice(settings));
  const [saved, setSaved] = useState(false);

  const patch = (changes: Partial<IntegrationsSettings>) => {
    setForm((prev) => ({ ...prev, ...changes }));
    setSaved(false);
  };

  const handleSave = () => {
    onSave(form);
    setSaved(true);
  };

  return (
    <CollapsibleSection
      title="Integrations"
      subtitle="JIRA & GitHub credentials"
      defaultOpen={false}
    >
      <div className="integration-section">
        <div className="integration-card">
          <div className="integration-name">JIRA</div>
          <div className="form-group">
            <label>Base URL</label>
            <input
              type="text"
              value={form.jiraBaseUrl}
              onChange={(e) => patch({ jiraBaseUrl: e.target.value })}
              placeholder="https://your-org.atlassian.net"
            />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              type="text"
              value={form.jiraEmail}
              onChange={(e) => patch({ jiraEmail: e.target.value })}
              placeholder="you@company.com"
            />
          </div>
          <div className="form-group">
            <label>API Token</label>
            <input
              type="password"
              value={form.jiraApiToken}
              onChange={(e) => patch({ jiraApiToken: e.target.value })}
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
              onChange={(e) => patch({ githubToken: e.target.value })}
              placeholder="ghp_..."
            />
          </div>
        </div>
      </div>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleSave}>
          Save Integrations
        </button>
        {saved && <span className="saved-indicator">Saved!</span>}
      </div>
    </CollapsibleSection>
  );
}
