import React, { useCallback, useEffect, useRef } from 'react';
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

  // Escape returns to the main page. While typing in a field, the first Escape
  // blurs that field (so it doesn't navigate away mid-edit); a second one then
  // goes back — mirroring the command palette's two-stage Escape.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      const isField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';
      e.preventDefault();
      if (isField) {
        target?.blur();
      } else {
        onBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  return (
    <div className="surface settings">
      <div className="topbar drag" data-tauri-drag-region>
        <button className="icon-btn" onClick={onBack} title="Back (Esc)" aria-label="Back">
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
