const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

autoUpdater.checkForUpdatesAndNotify();

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
      // Не добавлять дважды
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
        justify-content: flex-end;
        z-index: 2147483647;
        user-select: none;
        border-bottom: 1px solid #1e1f21;
      \`;

      function makeBtn(html, hoverColor) {
        const btn = document.createElement('button');
        btn.innerHTML = html;
        btn.style.cssText = \`
          width: 46px; height: 32px;
          background: transparent;
          border: none; cursor: pointer;
          -webkit-app-region: no-drag;
          color: #aaaaaa; font-size: 13px;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.12s, color 0.12s;
          padding: 0; margin: 0;
          font-family: 'Segoe UI', sans-serif;
        \`;
        btn.onmouseenter = () => { btn.style.background = hoverColor; if (hoverColor === '#c42b1c') btn.style.color = '#fff'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; btn.style.color = '#aaaaaa'; };
        return btn;
      }

      const minBtn = makeBtn('&#x2212;', '#2a2b2d');
      minBtn.title = 'Minimize';
      minBtn.onclick = () => window.electronAPI?.minimize();

      const maxBtn = makeBtn('&#x25A1;', '#2a2b2d');
      maxBtn.title = 'Maximize';
      maxBtn.onclick = () => window.electronAPI?.maximize();

      const clsBtn = makeBtn('&#x2715;', '#c42b1c');
      clsBtn.title = 'Close';
      clsBtn.onclick = () => window.electronAPI?.close();

      bar.appendChild(minBtn);
      bar.appendChild(maxBtn);
      bar.appendChild(clsBtn);
      document.documentElement.appendChild(bar);

      // Обновляем иконку кнопки при изменении состояния maximize
      window.electronAPI?.onMaximizeChange((isMax) => {
        maxBtn.innerHTML = isMax ? '&#x2750;' : '&#x25A1;';
        maxBtn.title = isMax ? 'Restore' : 'Maximize';
      });

      // Отодвигаем контент вниз, чтобы тайтлбар не перекрывал
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

  // Загружаем Railway сервер
  mainWindow.loadURL('https://grid-production-f3f4.up.railway.app');

  // Инжектим тайтлбар после каждой загрузки страницы
  mainWindow.webContents.on('did-finish-load', () => {
    injectTitlebar();
  });

  // Плавное появление без белой вспышки
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Сообщаем renderer об изменении состояния maximize
  mainWindow.on('maximize',   () => mainWindow.webContents.send('maximize-change', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('maximize-change', false));

  // Закрытие — сворачиваем в трей вместо выхода
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!app.trayHintShown) {
        tray.displayBalloon({
          title: 'GRID',
          content: 'Running in background. Right-click tray icon to quit.',
          iconType: 'info',
        });
        app.trayHintShown = true;
      }
    }
  });

  // Открывать внешние ссылки в браузере, не в Electron
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
    const img = nativeImage.createEmpty();
    tray = new Tray(img);
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Open GRID',  click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit',       click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('GRID');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── IPC — управление окном из renderer (кнопки minimize/maximize/close) ──
ipcMain.on('win-minimize',  () => mainWindow.minimize());
ipcMain.on('win-maximize',  () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',     () => mainWindow.close());
ipcMain.on('win-is-max',    (e) => { e.returnValue = mainWindow.isMaximized(); });

// ── IPC — нативные уведомления ──
ipcMain.on('notify', (e, { title, body }) => {
  if (Notification.isSupported() && !mainWindow.isFocused()) {
    new Notification({ title: title || 'GRID', body, icon: path.join(__dirname, 'public', 'icon.png') }).show();
  }
});

app.whenReady().then(() => {
  createTray();
  createWindow();

  // Глобальная горячая клавиша — показать/скрыть окно
  globalShortcut.register('Alt+G', () => {
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// На Windows приложение не должно закрываться когда все окна закрыты
app.on('window-all-closed', (e) => {
  e.preventDefault();
});
