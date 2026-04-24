const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
require('@electron/remote/main').initialize()

let win

function setThumbbar(playing) {
  if (!win || process.platform !== 'win32') return
  const a = path.join(__dirname, '..', 'assets')
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(a, 'prev.png'))),  click() { win.webContents.send('media-prev') } },
    playing
      ? { tooltip: 'Pause', icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(a, 'pause.png'))), click() { win.webContents.send('media-pause') } }
      : { tooltip: 'Play',  icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(a, 'play.png'))),  click() { win.webContents.send('media-play') } },
    { tooltip: 'Next',     icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(a, 'next.png'))),  click() { win.webContents.send('media-next') } }
  ])
}

function createWindow() {
  app.setName("last's player")
  app.setAppUserModelId("lasts.player")

  win = new BrowserWindow({
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
  win.webContents.on('did-finish-load', () => setThumbbar(false))
}

ipcMain.on('update-play-state', (_e, playing) => setThumbbar(playing))

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })