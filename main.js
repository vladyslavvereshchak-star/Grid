const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// ── Auto Updater настройка ──
autoUpdater.autoDownload = true;        // качать автоматически в фоне
autoUpdater.autoInstallOnAppQuit = true; // установить при следующем закрытии

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  // Уведомляем пользователя что нашлось обновление
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      type: 'available',
      version: info.version
    });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('App is up to date.');
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) {
    // Показываем прогресс скачивания в тайтлбаре
    mainWindow.setProgressBar(progress.percent / 100);
    mainWindow.webContents.send('update-status', {
      type: 'progress',
      percent: Math.round(progress.percent)
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  // Прогресс бар убираем
  if (mainWindow) mainWindow.setProgressBar(-1);

  // Спрашиваем пользователя — установить сейчас или при следующем запуске
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: 'GRID Update Ready',
    message: `Version ${info.version} downloaded`,
    detail: 'Restart now to apply the update, or it will install automatically on next launch.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    icon: path.join(__dirname, 'public', 'icon.png'),
  });

  if (result === 0) {
    isQuitting = true;
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', (err) => {
  console.error('AutoUpdater error:', err.message);
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Одна копия приложения ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function injectTitlebar() {
  mainWindow.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('__grid_titlebar')) return;

      const bar = document.createElement('div');
      bar.id = '__grid_titlebar';
      bar.style.cssText = \`
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 32px;
        background: #0c0d0e;
        -webkit-app-region: drag;
        display: flex;
        align-items: center;
        justify-content: space-between;
        z-index: 2147483647;
        user-select: none;
        border-bottom: 1px solid #1e1f21;
      \`;

      // Левая часть — лого и версия
      const left = document.createElement('div');
      left.style.cssText = 'display:flex;align-items:center;gap:8px;padding-left:12px;-webkit-app-region:drag';
      left.innerHTML = \`
        <svg width="14" height="14" viewBox="0 0 22 22" fill="none">
          <rect x="1" y="1" width="8" height="8" rx="1.5" stroke="#00E5FF" stroke-width="1.5" fill="none"/>
          <rect x="13" y="1" width="8" height="8" rx="1.5" stroke="#00E5FF" stroke-width="1.5" fill="none"/>
          <rect x="1" y="13" width="8" height="8" rx="1.5" stroke="#00E5FF" stroke-width="1.5" fill="none"/>
          <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="#00E5FF" stroke-width="1.5" fill="none"/>
          <circle cx="11" cy="11" r="2.5" fill="#00E5FF"/>
        </svg>
        <span style="font-size:10px;color:#2a3540;letter-spacing:0.1em;font-family:JetBrains Mono,monospace">GRID</span>
        <span id="__update_badge" style="display:none;font-size:9px;color:#00E5FF;background:rgba(0,229,255,0.1);border:1px solid rgba(0,229,255,0.2);padding:1px 6px;border-radius:4px;letter-spacing:0.06em"></span>
      \`;

      // Правая часть — кнопки окна
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;-webkit-app-region:no-drag';

      function makeBtn(html, hoverColor) {
        const btn = document.createElement('button');
        btn.innerHTML = html;
        btn.style.cssText = \`
          width:46px;height:32px;background:transparent;border:none;cursor:pointer;
          -webkit-app-region:no-drag;color:#555;font-size:13px;
          display:flex;align-items:center;justify-content:center;
          transition:background 0.12s,color 0.12s;padding:0;margin:0;
          font-family:'Segoe UI',sans-serif;
        \`;
        btn.onmouseenter = () => { btn.style.background = hoverColor; if (hoverColor === '#c42b1c') btn.style.color = '#fff'; else btn.style.color = '#ccc'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; btn.style.color = '#555'; };
        return btn;
      }

      const minBtn = makeBtn('&#x2212;', '#2a2b2d');
      minBtn.onclick = () => window.electronAPI?.minimize();

      const maxBtn = makeBtn('&#x25A1;', '#2a2b2d');
      maxBtn.onclick = () => window.electronAPI?.maximize();

      const clsBtn = makeBtn('&#x2715;', '#c42b1c');
      clsBtn.onclick = () => window.electronAPI?.close();

      right.appendChild(minBtn);
      right.appendChild(maxBtn);
      right.appendChild(clsBtn);

      bar.appendChild(left);
      bar.appendChild(right);
      document.documentElement.appendChild(bar);

      window.electronAPI?.onMaximizeChange((isMax) => {
        maxBtn.innerHTML = isMax ? '&#x2750;' : '&#x25A1;';
        maxBtn.title = isMax ? 'Restore' : 'Maximize';
      });

      const style = document.createElement('style');
      style.id = '__grid_titlebar_style';
      style.textContent = 'html { margin-top: 32px !important; }';
      document.head.appendChild(style);
    })();
  `).catch(console.error);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0c0d0e',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadURL('https://grid-production-f3f4.up.railway.app');

  mainWindow.webContents.on('did-finish-load', () => {
    injectTitlebar();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Проверяем обновления через 3 сек после запуска
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
  });

  mainWindow.on('maximize',   () => mainWindow.webContents.send('maximize-change', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('maximize-change', false));

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!app.trayHintShown) {
        try {
          tray.displayBalloon({
            title: 'GRID',
            content: 'Running in background. Right-click tray icon to quit.',
            iconType: 'info',
          });
        } catch(e) {}
        app.trayHintShown = true;
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'public', 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch(e) {
    const { nativeImage } = require('electron');
    tray = new Tray(nativeImage.createEmpty());
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Open GRID',         click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
    { type: 'separator' },
    { label: 'Quit',              click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('GRID');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

// IPC — окно
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow?.close());
ipcMain.on('win-is-max',   (e) => { e.returnValue = mainWindow?.isMaximized() ?? false; });

// IPC — уведомления
ipcMain.on('notify', (e, { title, body }) => {
  try {
    if (Notification.isSupported() && mainWindow && !mainWindow.isFocused()) {
      new Notification({ title: title || 'GRID', body }).show();
    }
  } catch(e) {}
});

// IPC — ручная проверка обновлений
ipcMain.on('get-version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('check-updates', () => {
  autoUpdater.checkForUpdatesAndNotify();
});

app.whenReady().then(() => {
  createTray();
  createWindow();

  globalShortcut.register('Alt+G', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() && mainWindow.isFocused() ? mainWindow.hide() : mainWindow.show();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
