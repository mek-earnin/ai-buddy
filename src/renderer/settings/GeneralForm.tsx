import React, { useState } from 'react';
import { AppSettings } from '../../shared/types';
import CollapsibleSection from './CollapsibleSection';

/** The slice of settings this self-contained form owns. */
export type GeneralSettings = Pick<AppSettings, 'autoPaste' | 'globalShortcut'>;

interface GeneralFormProps {
  /** Initial values. The form keeps its own internal copy after mount. */
  settings: GeneralSettings;
  /** Persist the given changes. Called when the user clicks Save. */
  onSave: (changes: Partial<AppSettings>) => void;
}

const pickSlice = (s: GeneralSettings): GeneralSettings => ({
  autoPaste: s.autoPaste,
  globalShortcut: s.globalShortcut,
});

/**
 * Self-contained "General" form: app behavior and the global shortcut. Edits
 * are held locally and persisted on Save.
 */
export default function GeneralForm({ settings, onSave }: GeneralFormProps) {
  const [form, setForm] = useState<GeneralSettings>(() => pickSlice(settings));
  const [saved, setSaved] = useState(false);

  const patch = (changes: Partial<GeneralSettings>) => {
    setForm((prev) => ({ ...prev, ...changes }));
    setSaved(false);
  };

  const handleSave = () => {
    onSave(form);
    setSaved(true);
  };

  return (
    <CollapsibleSection title="General" subtitle="App behavior & global shortcut">
      <div
        className="toggle-row"
        onClick={() => patch({ autoPaste: !form.autoPaste })}
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
          onChange={(e) => patch({ globalShortcut: e.target.value })}
          placeholder="Ctrl+Shift+Space"
        />
        <span className="hint">Applied immediately on save</span>
      </div>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleSave}>
          Save General
        </button>
        {saved && <span className="saved-indicator">Saved!</span>}
      </div>
    </CollapsibleSection>
  );
}
