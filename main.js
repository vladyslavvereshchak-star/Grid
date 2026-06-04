const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,          // убираем стандартный заголовок Windows
    titleBarStyle: 'hidden',
    backgroundColor: '#0c0d0e',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false, // показываем только когда готово
  });

  // Загружаем локальный сервер
  mainWindow.loadURL('http://localhost:3000');

  // Плавное появление без белой вспышки
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Закрытие — сворачиваем в трей вместо выхода
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      // Показываем подсказку только первый раз
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
  // Используем иконку если есть, иначе создаём пустую
  const iconPath = path.join(__dirname, 'public', 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch(e) {
    // Если иконки нет — создаём дефолтную
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
  require('./server.js');

  setTimeout(() => {
    createTray();
    createWindow();
  }, 3000);

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
