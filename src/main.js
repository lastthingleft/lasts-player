const { app, BrowserWindow } = require('electron')
require('@electron/remote/main').initialize()

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    frame: false,
    icon: "./assets/favicon.ico",
    resizable: true,
    transparent: false,
    backgroundColor: '#0e0f11',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  })
  require('@electron/remote/main').enable(win.webContents)
  win.loadFile('index.html')
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })