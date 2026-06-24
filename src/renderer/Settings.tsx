import React, { useCallback, useRef } from 'react';
import { AppSettings } from '../shared/types';
import { CloseGlyph } from './icons';
import AiProviderForm from './settings/AiProviderForm';
import PromptsForm from './settings/PromptsForm';
import IntegrationsForm from './settings/IntegrationsForm';
import GeneralForm from './settings/GeneralForm';

interface SettingsProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onBack: () => void;
  onClose: () => void;
}

/**
 * Settings shell. Each section is a self-contained form that owns its slice of
 * `AppSettings` and decides how it saves (auto vs. manual). This container only
 * merges each form's partial changes into the full settings object and persists
 * them — so the forms could each be rendered standalone elsewhere.
 */
export default function Settings({ settings, onSave, onBack, onClose }: SettingsProps) {
  // Master copy used to merge partial updates coming from each form.
  const currentRef = useRef<AppSettings>(settings);

  const persist = useCallback(
    (changes: Partial<AppSettings>) => {
      const next = { ...currentRef.current, ...changes };
      currentRef.current = next;
      onSave(next);
    },
    [onSave]
  );

  return (
    <div className="surface settings">
      <div className="topbar drag" data-tauri-drag-region>
        <button className="icon-btn" onClick={onBack} title="Back" aria-label="Back">
          ←
        </button>
        <span className="topbar-title">Settings</span>
        <span className="topbar-spacer" />
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseGlyph />
        </button>
      </div>

      <div className="settings-content">
        <AiProviderForm settings={settings} onSave={persist} />
        <PromptsForm settings={settings} onSave={persist} />
        <IntegrationsForm settings={settings} onSave={persist} />
        <GeneralForm settings={settings} onSave={persist} />
      </div>
    </div>
  );
}
