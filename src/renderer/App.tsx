import React, { useState, useEffect } from 'react';
import CommandPalette from './CommandPalette';
import Settings from './Settings';
import { AppSettings } from '../shared/types';

type View = 'palette' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('palette');
  const [selectedText, setSelectedText] = useState('');
  const [targetEditable, setTargetEditable] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Bumped every time the window is (re)shown. The webview is never torn down,
  // so we key the palette on this to force a fresh mount on each open — which
  // refocuses the search field and resets the palette to its initial view.
  const [showNonce, setShowNonce] = useState(0);

  useEffect(() => {
    window.aibuddy.getSettings().then(setSettings);

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'show-settings') {
        setView('settings');
      }
      if (event.data?.channel === 'selected-text') {
        setSelectedText(event.data.text || '');
        setTargetEditable(event.data.editable !== false);
        setView('palette');
        setShowNonce((n) => n + 1);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Persist without navigating away — the AI provider section auto-saves, and
  // the manual sections save independently. Use the Back button to leave.
  const handleSettingsSaved = async (newSettings: AppSettings) => {
    await window.aibuddy.saveSettings(newSettings);
    setSettings(newSettings);
  };

  const handleClose = () => {
    window.aibuddy.hideWindow();
  };

  if (!settings) {
    return <div className="surface boot" />;
  }

  if (view === 'settings') {
    return (
      <Settings
        settings={settings}
        onSave={handleSettingsSaved}
        onBack={() => setView('palette')}
        onClose={handleClose}
      />
    );
  }

  return (
    <CommandPalette
      key={showNonce}
      selectedText={selectedText}
      targetEditable={targetEditable}
      settings={settings}
      onOpenSettings={() => setView('settings')}
      onClose={handleClose}
    />
  );
}
