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

  useEffect(() => {
    window.aibuddy.getSettings().then(setSettings);

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'show-settings') {
        setView('settings');
      }
      if (event.data?.channel === 'selected-text') {
        setSelectedText(event.data.text || '');
        setTargetEditable(event.data.editable !== false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSettingsSaved = async (newSettings: AppSettings) => {
    await window.aibuddy.saveSettings(newSettings);
    setSettings(newSettings);
    setView('palette');
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
      selectedText={selectedText}
      targetEditable={targetEditable}
      settings={settings}
      onOpenSettings={() => setView('settings')}
      onClose={handleClose}
    />
  );
}
