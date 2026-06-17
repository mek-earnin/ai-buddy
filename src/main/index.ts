import {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  ipcMain,
  Tray,
  Menu,
  screen,
  shell,
  nativeImage,
  safeStorage,
} from 'electron';
import * as path from 'path';
import { generateText, generateTextStream } from '../shared/ai-service';
import { IPC_CHANNELS, AppSettings, GenerateRequest } from '../shared/types';
import { fetchJiraActivity } from '../shared/data-sources/jira';
import { fetchGitHubActivity } from '../shared/data-sources/github';
import { loadSettings, saveSettings } from './store';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: AppSettings;
let previousClipboard = '';
let previousApp = '';
let previousFocusEditable = true;

// macOS accessibility roles that accept typed/pasted text.
const EDITABLE_AX_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];

function createWindow(): BrowserWindow {
  const { x, y } = screen.getCursorScreenPoint();

  const win = new BrowserWindow({
    width: 480,
    height: 600,
    x: x - 240,
    y: y + 10,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  return win;
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon: Electron.NativeImage;

  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromBuffer(Buffer.alloc(0));
    } else {
      trayIcon = trayIcon.resize({ width: 18, height: 18 });
    }
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('AIBuddy');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show AIBuddy',
      click: () => showToolPalette(),
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('show-settings');
          mainWindow.show();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function registerShortcut(): void {
  globalShortcut.unregisterAll();

  const shortcut = settings.globalShortcut || 'Alt+Space';
  const registered = globalShortcut.register(shortcut, () => {
    showToolPalette();
  });

  if (!registered) {
    console.error(`Failed to register shortcut: ${shortcut}`);
  }
}

async function showToolPalette(): Promise<void> {
  const { execSync } = require('child_process');
  const isMac = process.platform === 'darwin';

  if (isMac) {
    try {
      const output = execSync(
        `osascript -e 'tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set elementRole to ""
          try
            set elementRole to value of attribute "AXRole" of (value of attribute "AXFocusedUIElement" of frontApp)
          end try
          return appName & "\n" & elementRole
        end tell'`
      ).toString();
      const [appName = '', role = ''] = output.split('\n');
      previousApp = appName.trim();
      const trimmedRole = role.trim();
      // Default to allowing paste unless we positively detect a non-editable target.
      previousFocusEditable = trimmedRole ? EDITABLE_AX_ROLES.includes(trimmedRole) : true;
    } catch {
      previousApp = '';
      previousFocusEditable = true;
    }
  } else {
    previousFocusEditable = true;
  }

  previousClipboard = clipboard.readText();
  const sentinel = '\x00__AIBUDDY_SENTINEL__';
  clipboard.writeText(sentinel);

  if (isMac) {
    execSync(
      `osascript -e 'tell application "System Events" to keystroke "c" using command down'`
    );
  } else {
    execSync('xdotool key ctrl+c');
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const currentClipboard = clipboard.readText();
  const selectedText = currentClipboard === sentinel ? '' : currentClipboard;

  // Restore the user's clipboard immediately so the sentinel never lingers.
  // Otherwise a subsequent manual paste (e.g. into a Settings field) would
  // paste the sentinel string instead of the user's real clipboard content.
  clipboard.writeText(previousClipboard);

  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }
  mainWindow = createWindow();

  const { x, y } = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x, y });
  const bounds = display.workArea;

  let winX = x - 240;
  let winY = y + 10;

  if (winX + 480 > bounds.x + bounds.width) winX = bounds.x + bounds.width - 490;
  if (winX < bounds.x) winX = bounds.x + 10;
  if (winY + 600 > bounds.y + bounds.height) winY = y - 610;

  mainWindow.setPosition(winX, winY);

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('selected-text', selectedText, previousFocusEditable);
    }
  });
}

function aiConfig() {
  return {
    provider: settings.provider,
    openaiApiKey: settings.openaiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    openaiModel: settings.openaiModel,
    anthropicModel: settings.anthropicModel,
  };
}

async function handleGenerate(
  _event: Electron.IpcMainInvokeEvent,
  request: GenerateRequest
): Promise<string> {
  return generateText(request.systemPrompt, request.userContent, aiConfig());
}

async function handleGenerateStream(
  event: Electron.IpcMainInvokeEvent,
  request: GenerateRequest
): Promise<string> {
  return generateTextStream(request.systemPrompt, request.userContent, aiConfig(), (delta) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC_CHANNELS.GENERATE_STREAM_CHUNK, delta);
    }
  });
}

async function handlePasteResult(
  _event: Electron.IpcMainInvokeEvent,
  text: string
): Promise<void> {
  const { exec } = require('child_process');
  const isMac = process.platform === 'darwin';

  clipboard.writeText(text);

  if (mainWindow) {
    mainWindow.hide();
  }

  if (isMac && previousApp) {
    exec(
      `osascript -e '
        tell application "${previousApp}" to activate
        delay 0.5
        tell application "System Events" to keystroke "v" using command down
      '`
    );
  } else if (!isMac) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    exec('xdotool key ctrl+v');
  }

  setTimeout(() => {
    clipboard.writeText(previousClipboard);
  }, 2000);
}

function setupIPC(): void {
  ipcMain.handle(IPC_CHANNELS.GENERATE_TEXT, handleGenerate);
  ipcMain.handle(IPC_CHANNELS.GENERATE_TEXT_STREAM, handleGenerateStream);

  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_TEXT, () => {
    return clipboard.readText();
  });

  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
    return settings;
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (_event, newSettings: AppSettings) => {
    settings = newSettings;
    saveSettings(settings);
    registerShortcut();
  });

  ipcMain.handle(IPC_CHANNELS.PASTE_RESULT, handlePasteResult);

  ipcMain.on(IPC_CHANNELS.HIDE_WINDOW, () => {
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.FETCH_JIRA_ACTIVITY, async () => {
    return fetchJiraActivity({
      baseUrl: settings.jiraBaseUrl,
      email: settings.jiraEmail,
      apiToken: settings.jiraApiToken,
    });
  });

  ipcMain.handle(IPC_CHANNELS.FETCH_GITHUB_ACTIVITY, async () => {
    return fetchGitHubActivity({
      token: settings.githubToken,
    });
  });
}

app.name = 'AIBuddy';

app.whenReady().then(() => {
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text') {
      console.warn(
        '[Security] No system keyring available (backend: basic_text). API keys will NOT be encrypted at rest.'
      );
    }
  }

  settings = loadSettings();

  createTray();
  registerShortcut();
  setupIPC();

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep app running in system tray
});

if (process.platform === 'darwin') {
  app.dock?.hide();
}
