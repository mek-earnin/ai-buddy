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
  systemPreferences,
  dialog,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, exec } from 'child_process';
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
// Show the "enable Automation" guidance at most once per session.
let automationWarningShown = false;

const isMac = process.platform === 'darwin';

// macOS accessibility roles that accept typed/pasted text.
const EDITABLE_AX_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];

function logFilePath(): string {
  return path.join(app.getPath('userData'), 'logs.log');
}

// Lightweight file logger so failures are diagnosable on machines without a
// console attached (i.e. a normal packaged install).
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch {
    // Logging is best-effort; never let it break the app.
  }
  console.log(message);
}

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

function openPrivacyPane(anchor: string): void {
  // x-apple.systempreferences URLs open the specific Privacy & Security pane.
  shell
    .openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
    .catch(() => {
      // Fall back to opening System Settings at all if the deep link fails.
      shell.openExternal('x-apple.systempreferences:').catch(() => undefined);
    });
}

function showPermissionsHelp(): void {
  const detail = isMac
    ? 'AIBuddy needs two macOS permissions to read your selection and paste results:\n\n' +
      '1. Accessibility — System Settings > Privacy & Security > Accessibility > enable AIBuddy.\n' +
      '2. Automation — System Settings > Privacy & Security > Automation > AIBuddy > enable "System Events".\n\n' +
      'After changing these, fully quit and reopen AIBuddy.'
    : 'AIBuddy uses xdotool to read your selection and paste results. Make sure xdotool is installed.';

  const buttons = isMac
    ? ['Open Accessibility', 'Open Automation', 'Close']
    : ['Close'];

  dialog
    .showMessageBox({
      type: 'info',
      title: 'AIBuddy Permissions',
      message: 'Permissions needed',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    })
    .then(({ response }) => {
      if (!isMac) return;
      if (response === 0) openPrivacyPane('Privacy_Accessibility');
      else if (response === 1) openPrivacyPane('Privacy_Automation');
    })
    .catch(() => undefined);
}

function warnAutomationOnce(): void {
  if (automationWarningShown || !isMac) return;
  automationWarningShown = true;
  dialog
    .showMessageBox({
      type: 'warning',
      title: 'AIBuddy needs Automation permission',
      message: "AIBuddy couldn't capture your selected text",
      detail:
        'macOS blocked AIBuddy from controlling "System Events". The palette still ' +
        'opened, but to capture and paste text automatically, enable AIBuddy under ' +
        'System Settings > Privacy & Security > Automation (and Accessibility), then ' +
        'restart AIBuddy.',
      buttons: ['Open Automation Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) openPrivacyPane('Privacy_Automation');
    })
    .catch(() => undefined);
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

  const template: Electron.MenuItemConstructorOptions[] = [
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
    {
      label: 'Permissions Help',
      click: () => showPermissionsHelp(),
    },
    {
      label: 'Open Logs',
      click: () => {
        shell.openPath(logFilePath()).catch(() => undefined);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function registerShortcut(): void {
  globalShortcut.unregisterAll();

  const shortcut = settings.globalShortcut || 'Alt+Space';
  let registered = false;
  try {
    registered = globalShortcut.register(shortcut, () => {
      showToolPalette();
    });
  } catch (err) {
    log(`Error registering shortcut "${shortcut}": ${String(err)}`);
  }

  if (registered) {
    log(`Registered global shortcut: ${shortcut}`);
  } else {
    log(`Failed to register shortcut: ${shortcut}`);
    dialog
      .showMessageBox({
        type: 'warning',
        title: 'AIBuddy shortcut unavailable',
        message: `Couldn't register the shortcut "${shortcut}"`,
        detail:
          'Another app may already be using it. Open Settings from the AIBuddy ' +
          'tray icon and choose a different shortcut.',
        buttons: ['OK'],
      })
      .catch(() => undefined);
  }
}

// Detect the frontmost app and whether its focused element accepts text. Must
// run while the other app is still frontmost (before we show our window).
function detectFrontmostTarget(): void {
  previousApp = '';
  previousFocusEditable = true;
  if (!isMac) return;

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
      end tell'`,
      { timeout: 3000 }
    ).toString();
    const [appName = '', role = ''] = output.split('\n');
    previousApp = appName.trim();
    const trimmedRole = role.trim();
    // Default to allowing paste unless we positively detect a non-editable target.
    previousFocusEditable = trimmedRole ? EDITABLE_AX_ROLES.includes(trimmedRole) : true;
  } catch (err) {
    log(`Frontmost detection failed: ${String(err)}`);
  }
}

// Capture the user's current selection by simulating copy. Returns the selected
// text, or '' if capture failed or there was no selection. Never throws.
function captureSelection(): string {
  previousClipboard = clipboard.readText();
  const sentinel = '\x00__AIBUDDY_SENTINEL__';
  clipboard.writeText(sentinel);

  try {
    if (isMac) {
      execSync(
        `osascript -e 'tell application "System Events" to keystroke "c" using command down'`,
        { timeout: 3000 }
      );
    } else {
      execSync('xdotool key ctrl+c', { timeout: 3000 });
    }
  } catch (err) {
    log(`Selection copy failed: ${String(err)}`);
    // Restore the clipboard and signal failure so the palette opens empty.
    clipboard.writeText(previousClipboard);
    warnAutomationOnce();
    return '';
  }

  // Give the target app a moment to place the selection on the clipboard.
  const start = Date.now();
  while (Date.now() - start < 500) {
    // Busy-wait briefly; keystroke delivery is async but fast.
    if (clipboard.readText() !== sentinel) break;
  }

  const currentClipboard = clipboard.readText();
  const selectedText = currentClipboard === sentinel ? '' : currentClipboard;

  // Restore the user's clipboard immediately so the sentinel never lingers.
  clipboard.writeText(previousClipboard);

  return selectedText;
}

function showToolPalette(): void {
  // Order matters: detect + capture while the *other* app is frontmost, then
  // open our window. Capture is fully guarded so the palette ALWAYS appears,
  // even when macOS blocks the automation.
  detectFrontmostTarget();
  const selectedText = captureSelection();

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
  clipboard.writeText(text);

  if (mainWindow) {
    mainWindow.hide();
  }

  try {
    if (isMac && previousApp) {
      exec(
        `osascript -e '
          tell application "${previousApp}" to activate
          delay 0.5
          tell application "System Events" to keystroke "v" using command down
        '`,
        (err) => {
          if (err) {
            log(`Auto-paste failed: ${String(err)}`);
            warnAutomationOnce();
          }
        }
      );
    } else if (!isMac) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      exec('xdotool key ctrl+v', (err) => {
        if (err) log(`Auto-paste failed: ${String(err)}`);
      });
    }
  } catch (err) {
    log(`Auto-paste error: ${String(err)}`);
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
      log(
        '[Security] No system keyring available (backend: basic_text). API keys will NOT be encrypted at rest.'
      );
    }
  }

  // Surface the macOS Accessibility prompt early so keystroke simulation works.
  if (isMac) {
    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      log(`Accessibility trusted: ${trusted}`);
    } catch (err) {
      log(`Accessibility check failed: ${String(err)}`);
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
