import React, { useState } from 'react';
import { AppSettings, ToneId, TonePrompts } from '../../shared/types';
import { TONES } from '../../tools/rephrase';
import { DEFAULT_PROMPT_REFINER_PROMPT } from '../../tools/prompt-refiner';
import CollapsibleSection from './CollapsibleSection';

/** The slice of settings this self-contained form owns. */
export type PromptsSettings = Pick<AppSettings, 'tonePrompts' | 'promptRefinerPrompt'>;

interface PromptsFormProps {
  /** Initial values. The form keeps its own internal copy after mount. */
  settings: PromptsSettings;
  /** Persist the given changes. Called when the user clicks Save. */
  onSave: (changes: Partial<AppSettings>) => void;
}

const PROMPT_PLACEHOLDER = 'Enter your custom prompt…';

/**
 * Replace empty prompt fields with their defaults so each textarea shows the
 * actual prompt that will be used, ready for the user to edit or replace.
 */
function prefillDefaults(s: PromptsSettings): PromptsSettings {
  const tonePrompts = {} as TonePrompts;
  for (const tone of TONES) {
    const current = s.tonePrompts[tone.id];
    tonePrompts[tone.id] = current && current.trim() ? current : tone.defaultPrompt;
  }
  return {
    tonePrompts,
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

function normalizeForSave(s: PromptsSettings): PromptsSettings {
  const tonePrompts = {} as TonePrompts;
  for (const tone of TONES) {
    tonePrompts[tone.id] = collapseToDefault(s.tonePrompts[tone.id] ?? '', tone.defaultPrompt);
  }
  return {
    tonePrompts,
    promptRefinerPrompt: collapseToDefault(s.promptRefinerPrompt, DEFAULT_PROMPT_REFINER_PROMPT),
  };
}

/**
 * Self-contained prompts form (rephrase tones + prompt refiner). Edits are held
 * locally and only persisted when the user clicks Save.
 */
export default function PromptsForm({ settings, onSave }: PromptsFormProps) {
  const [form, setForm] = useState<PromptsSettings>(() => prefillDefaults(settings));
  const [saved, setSaved] = useState(false);

  const setTonePrompt = (toneId: ToneId, value: string) => {
    setForm((prev) => ({
      ...prev,
      tonePrompts: { ...prev.tonePrompts, [toneId]: value },
    }));
    setSaved(false);
  };

  const setRefiner = (value: string) => {
    setForm((prev) => ({ ...prev, promptRefinerPrompt: value }));
    setSaved(false);
  };

  const handleSave = () => {
    const normalized = normalizeForSave(form);
    onSave({
      tonePrompts: normalized.tonePrompts as TonePrompts,
      promptRefinerPrompt: normalized.promptRefinerPrompt,
    });
    // Re-prefill so cleared fields show their default again after saving.
    setForm(prefillDefaults(normalized));
    setSaved(true);
  };

  return (
    <CollapsibleSection
      title="Prompts"
      subtitle="Rephrase tones & prompt refiner instructions"
      defaultOpen={false}
    >
      <div className="tone-prompts-section">
          {TONES.map((tone) => (
            <div key={tone.id} className="form-group">
              <label>
                {tone.emoji} {tone.label} Prompt
              </label>
              <textarea
                value={form.tonePrompts[tone.id]}
                onChange={(e) => setTonePrompt(tone.id, e.target.value)}
                placeholder={PROMPT_PLACEHOLDER}
                rows={4}
                className="prompt-textarea"
              />
              <span className="hint">Clear and save to restore the default prompt</span>
            </div>
          ))}

          <div className="form-group">
            <label>🛠️ Prompt Refiner Instructions</label>
            <textarea
              value={form.promptRefinerPrompt}
              onChange={(e) => setRefiner(e.target.value)}
              placeholder={PROMPT_PLACEHOLDER}
              rows={8}
              className="prompt-textarea"
            />
            <span className="hint">Clear and save to restore the default prompt</span>
          </div>
        </div>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleSave}>
          Save Prompts
        </button>
        {saved && <span className="saved-indicator">Saved!</span>}
      </div>
    </CollapsibleSection>
  );
}
