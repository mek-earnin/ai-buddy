import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Action, GROUP_ORDER, ScoredAction, searchActions } from '../tools/actions';
import { AppSettings, UpdateStatus } from '../shared/types';
import { CloseGlyph, GearGlyph } from './icons';

interface CommandPaletteProps {
  selectedText: string;
  targetEditable: boolean;
  settings: AppSettings;
  appVersion: string;
  update: UpdateStatus | null;
  onInstallUpdate: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

interface Section {
  key: string;
  label?: string;
  items: ScoredAction[];
}

type View = 'list' | 'ask' | 'running' | 'result';

const RECENT_KEY = 'aibuddy:recent-actions';
const MAX_RECENT = 3;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch {
    // Ignore storage failures — recents are a non-critical convenience.
  }
}

function isMacPlatform(): boolean {
  return navigator.platform.toLowerCase().includes('mac');
}

export default function CommandPalette({
  selectedText,
  targetEditable,
  settings,
  appVersion,
  update,
  onInstallUpdate,
  onOpenSettings,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [inputText, setInputText] = useState(selectedText);
  const [editingInput, setEditingInput] = useState(false);

  const [view, setView] = useState<View>('list');
  const [activeAction, setActiveAction] = useState<Action | null>(null);
  const [result, setResult] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [needsInput, setNeedsInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [askQuestion, setAskQuestion] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const mod = isMacPlatform() ? '\u2318' : 'Ctrl';

  useEffect(() => {
    setInputText(selectedText);
    setEditingInput(false);
  }, [selectedText]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const scored = useMemo(() => searchActions(query), [query]);

  // When the query is empty, group results; otherwise show a flat relevance list.
  const isGrouped = query.trim().length === 0;

  const recentActions = useMemo(() => {
    if (!isGrouped) return [];
    return recent
      .map((id) => scored.find((s) => s.action.id === id))
      .filter(Boolean) as ScoredAction[];
  }, [recent, scored, isGrouped]);

  // Sections drive both layout and navigation, so rendered order === nav order.
  const sections: Section[] = useMemo(() => {
    if (!isGrouped) {
      return scored.length ? [{ key: 'results', items: scored }] : [];
    }
    const built: Section[] = [];
    if (recentActions.length) {
      built.push({ key: 'recent', label: 'Recent', items: recentActions });
    }
    for (const group of GROUP_ORDER) {
      const items = scored.filter((s) => s.action.group === group);
      if (items.length) built.push({ key: group, label: group, items });
    }
    return built;
  }, [scored, recentActions, isGrouped]);

  // Flat list backing keyboard navigation and the mod+number shortcuts.
  const navList: ScoredAction[] = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    const el = document.getElementById(`cmd-item-${highlight}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const run = useCallback(
    async (action: Action, opts?: { question?: string }) => {
      // Ask uses a dedicated composer: the selection becomes read-only context
      // and the user types a separate question. Open it unless we already have a
      // question (i.e. the composer is submitting or Regenerate is re-running).
      if (action.id === 'ask' && opts?.question === undefined) {
        setActiveAction(action);
        setAskQuestion('');
        setError('');
        setNeedsInput(false);
        setView('ask');
        setTimeout(() => askRef.current?.focus(), 0);
        return;
      }

      const text = inputText.trim();
      if (action.requiresSelection && !text) {
        setNeedsInput(true);
        setEditingInput(true);
        setError('');
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }

      setNeedsInput(false);
      setActiveAction(action);
      setResult('');
      setError('');
      setStreaming(false);
      setView('running');

      // Remember this action for the Recent group on next open.
      const nextRecent = [action.id, ...recent.filter((id) => id !== action.id)].slice(
        0,
        MAX_RECENT
      );
      setRecent(nextRecent);
      saveRecent(nextRecent);

      try {
        const request = await action.buildRequest({
          input: inputText,
          question: opts?.question,
          settings,
          api: window.aibuddy,
        });

        let started = false;
        const generated = await window.aibuddy.generateTextStream(request, (delta) => {
          if (!started) {
            started = true;
            setStreaming(true);
            setView('result');
          }
          setResult((prev) => prev + delta);
        });

        setResult(generated);
        setStreaming(false);
        setView('result');
        if (settings.autoPaste && targetEditable && !action.disableAutoPaste && generated.trim()) {
          window.aibuddy.pasteResult(generated);
        }
      } catch (err: any) {
        setStreaming(false);
        setError(err?.message || `Couldn't run ${action.label}. Please try again.`);
        setView('result');
      }
    },
    [inputText, recent, settings, targetEditable]
  );

  const handlePaste = useCallback(() => {
    if (result) window.aibuddy.pasteResult(result);
  }, [result]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  const submitAsk = useCallback(() => {
    if (activeAction && askQuestion.trim()) {
      run(activeAction, { question: askQuestion });
    }
  }, [activeAction, askQuestion, run]);

  const handleRegenerate = useCallback(() => {
    if (!activeAction) return;
    if (activeAction.id === 'ask') {
      run(activeAction, { question: askQuestion });
    } else {
      run(activeAction);
    }
  }, [activeAction, askQuestion, run]);

  const backToList = useCallback(() => {
    setView('list');
    setResult('');
    setError('');
    setActiveAction(null);
    setAskQuestion('');
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  // Single keyboard hub for the whole surface.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inTextarea = target?.tagName === 'TEXTAREA';
      const metaOrCtrl = e.metaKey || e.ctrlKey;

      if (view === 'ask') {
        if (e.key === 'Escape') {
          e.preventDefault();
          backToList();
        }
        // Enter / Shift+Enter are handled by the question textarea itself.
        return;
      }

      if (view === 'running') {
        if (e.key === 'Escape') {
          e.preventDefault();
          backToList();
        }
        return;
      }

      if (view === 'result') {
        if (e.key === 'Escape') {
          e.preventDefault();
          backToList();
        } else if (streaming) {
          // Ignore commit shortcuts until the response finishes streaming.
        } else if (e.key === 'Enter' && result) {
          e.preventDefault();
          handlePaste();
        } else if (metaOrCtrl && e.key.toLowerCase() === 'c' && result) {
          e.preventDefault();
          handleCopy();
        } else if (metaOrCtrl && e.key.toLowerCase() === 'r' && activeAction) {
          e.preventDefault();
          handleRegenerate();
        }
        return;
      }

      // List view
      // Cmd+, — the standard macOS "Preferences" shortcut — opens Settings.
      if (metaOrCtrl && e.key === ',') {
        e.preventDefault();
        onOpenSettings();
        return;
      }

      if (metaOrCtrl && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (navList[idx]) {
          e.preventDefault();
          run(navList[idx].action);
        }
        return;
      }

      if (e.key === 'Escape') {
        if (inTextarea) {
          e.preventDefault();
          (target as HTMLTextAreaElement).blur();
          searchRef.current?.focus();
        } else {
          onClose();
        }
        return;
      }

      // Let the textarea own its own arrow/enter editing behavior.
      if (inTextarea) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(navList.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = navList[highlight];
        if (r) run(r.action);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    view,
    navList,
    highlight,
    result,
    activeAction,
    run,
    handlePaste,
    handleCopy,
    handleRegenerate,
    backToList,
    onClose,
    onOpenSettings,
    streaming,
  ]);

  if (view === 'ask') {
    const hasContext = inputText.trim().length > 0;
    return (
      <div className="surface">
        <div className="topbar drag" data-tauri-drag-region>
          <button className="icon-btn" onClick={backToList} title="Back (Esc)" aria-label="Back">
            <BackGlyph />
          </button>
          <span className="topbar-title">
            {activeAction?.icon} Ask
          </span>
          <span className="topbar-spacer" />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <CloseGlyph />
          </button>
        </div>

        <div className="ask-body">
          {hasContext && (
            <div className="context">
              <span className="context-label">Context — selected text</span>
              <div className="context-text">
                {inputText.slice(0, 240)}
                {inputText.length > 240 ? '…' : ''}
              </div>
            </div>
          )}

          <div className="ask-field">
            <span className="context-label">Your question</span>
            <textarea
              ref={askRef}
              className="context-textarea ask-textarea"
              value={askQuestion}
              onChange={(e) => setAskQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitAsk();
                }
              }}
              placeholder={
                hasContext ? 'Ask something about the selected text…' : 'Ask anything…'
              }
              rows={3}
            />
          </div>
        </div>

        <div className="result-actions">
          <button className="btn btn-primary" onClick={submitAsk} disabled={!askQuestion.trim()}>
            Ask <kbd>↵</kbd>
          </button>
        </div>
      </div>
    );
  }

  if (view === 'running' || view === 'result') {
    return (
      <div className="surface">
        <div className="topbar drag" data-tauri-drag-region>
          <button className="icon-btn" onClick={backToList} title="Back (Esc)" aria-label="Back">
            <BackGlyph />
          </button>
          <span className="topbar-title">
            {activeAction?.icon} {activeAction?.label}
          </span>
          <span className="topbar-spacer" />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <CloseGlyph />
          </button>
        </div>

        {view === 'running' && (
          <div className="result-body">
            <div className="skeleton-block">
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
              <div className="skeleton-line" />
              <div className="skeleton-line medium" />
            </div>
            <div className="working-hint">
              <span className="pulse-dot" /> Working on it…
            </div>
          </div>
        )}

        {view === 'result' && (
          <>
            <div className="result-body">
              {error ? (
                <div className="error-card">
                  <div className="error-title">Something went wrong</div>
                  <div className="error-detail">{error}</div>
                </div>
              ) : (
                <div className="result-text" tabIndex={0}>
                  {result}
                  {streaming && <span className="caret" />}
                </div>
              )}
            </div>

            {!streaming && !error && settings.autoPaste && !targetEditable && (
              <div className="working-hint auto-paste-note">
                Target isn’t a text field — copy it manually.
              </div>
            )}

            {streaming ? (
              <div className="result-actions streaming-bar">
                <span className="working-hint">
                  <span className="pulse-dot" /> Generating…
                </span>
              </div>
            ) : (
              <div className="result-actions">
                {error ? (
                  <>
                    <button className="btn btn-primary" onClick={handleRegenerate}>
                      Try again <kbd>{mod}R</kbd>
                    </button>
                    <button className="btn btn-ghost" onClick={backToList}>
                      Back <kbd>esc</kbd>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={handlePaste}>
                      Apply &amp; Paste <kbd>↵</kbd>
                    </button>
                    <button className="btn btn-ghost" onClick={handleCopy}>
                      {copied ? 'Copied!' : 'Copy'} <kbd>{mod}C</kbd>
                    </button>
                    <button className="btn btn-ghost" onClick={handleRegenerate}>
                      Regenerate <kbd>{mod}R</kbd>
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const renderRow = (scoredAction: ScoredAction, index: number, sectionKey: string) => {
    const isActive = index === highlight;
    const { action, segments } = scoredAction;
    return (
      <button
        key={`${sectionKey}-${action.id}`}
        id={`cmd-item-${index}`}
        className={`cmd-row ${isActive ? 'active' : ''}`}
        onClick={() => run(action)}
        onMouseMove={() => setHighlight(index)}
        role="option"
        aria-selected={isActive}
      >
        <span className="cmd-icon">{action.icon}</span>
        <span className="cmd-text">
          <span className="cmd-label">
            {segments.map((seg, i) =>
              seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
            )}
          </span>
          <span className="cmd-desc">{action.description}</span>
        </span>
        {index < 9 && (
          <kbd className="cmd-shortcut">
            {mod}
            {index + 1}
          </kbd>
        )}
      </button>
    );
  };

  return (
    <div className="surface">
      <div className="topbar drag" data-tauri-drag-region>
        <span className="brand">
          <svg
            className="brand-logo"
            viewBox="246 246 532 532"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle
              cx="512"
              cy="512"
              r="210"
              fill="none"
              stroke="currentColor"
              strokeWidth="92"
              strokeLinecap="round"
              strokeDasharray="989.6 329.9"
            />
            <circle cx="512" cy="512" r="96" fill="currentColor" />
            <circle cx="664" cy="360" r="80" fill="currentColor" />
          </svg>
          AI Buddy
          {appVersion && <span className="brand-version">v{appVersion}</span>}
        </span>
        {update?.available && update.version && (
          <button
            className="update-pill no-drag"
            onClick={onInstallUpdate}
            title={`AI Buddy ${update.version} is available — click to install`}
          >
            <span className="update-pill-dot" />
            Update to v{update.version}
          </button>
        )}
        <span className="topbar-spacer" />
        <button className="icon-btn no-drag" onClick={onOpenSettings} title={`Settings (${mod},)`} aria-label="Settings">
          <GearGlyph />
        </button>
        <button className="icon-btn no-drag" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseGlyph />
        </button>
      </div>

      <div className="search-row">
        <SearchGlyph />
        <input
          ref={searchRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search actions…"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
        />
      </div>

      <div className={`context ${needsInput ? 'needs-input' : ''}`}>
        {inputText && !editingInput ? (
          <div className="context-preview">
            <span className="context-label">Selected text</span>
            <div className="context-text">
              {inputText.slice(0, 240)}
              {inputText.length > 240 ? '…' : ''}
            </div>
            <button className="link-btn" onClick={() => setEditingInput(true)}>
              Edit
            </button>
          </div>
        ) : (
          <div className="context-edit">
            <span className="context-label">
              {needsInput ? 'Add some text to work on' : 'Input'}
            </span>
            <textarea
              ref={textareaRef}
              className="context-textarea"
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                if (needsInput && e.target.value.trim()) setNeedsInput(false);
              }}
              placeholder="Paste or type text here, or just pick an action below…"
              rows={2}
            />
          </div>
        )}
      </div>

      <div className="cmd-list" id="cmd-list" role="listbox" ref={listRef}>
        {navList.length === 0 ? (
          <div className="empty-state">
            <div className="empty-emoji">🔍</div>
            <div className="empty-title">No actions match “{query}”</div>
            <div className="empty-hint">Try “rephrase”, “summarize”, or “activity notes”.</div>
          </div>
        ) : (
          (() => {
            let runningIndex = -1;
            return sections.map((section) => (
              <div className="cmd-group" key={section.key}>
                {section.label && <div className="cmd-group-label">{section.label}</div>}
                {section.items.map((item) => {
                  runningIndex += 1;
                  return renderRow(item, runningIndex, section.key);
                })}
              </div>
            ));
          })()
        )}
      </div>

      <div className="footer">
        <span className="footer-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span className="footer-hint">
          <kbd>↵</kbd> run
        </span>
        <span className="footer-hint">
          <kbd>{mod},</kbd> settings
        </span>
        <span className="footer-hint">
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BackGlyph() {
  return (
    <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 3.5L5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
