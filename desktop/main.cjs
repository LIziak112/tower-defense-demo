const { app, BrowserWindow, ipcMain, net, protocol, screen } = require('electron');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const origin = 'td://game';
const bundle = resolve(__dirname, '../dist');
const saveName = 'tower-defense-profile-v1.json';
const resolutions = new Set(['auto', '1280x720', '1600x900', '1920x1080']);
const limit = 512 * 1024;

protocol.registerSchemesAsPrivileged([{ scheme: 'td', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Tower Defense Demo');
const userData = app.commandLine.getSwitchValue('user-data-dir');
if (isAbsolute(userData)) app.setPath('userData', userData);

function savePath() { return join(app.getPath('userData'), 'saves', saveName); }

function readProfile() {
  try {
    const raw = readFileSync(savePath(), 'utf8');
    return Buffer.byteLength(raw) <= limit ? raw : null;
  } catch { return null; }
}

function writeProfile(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > limit) return false;
  try {
    if (JSON.parse(raw)?.version !== 1) return false;
    const file = savePath();
    const pending = `${file}.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(pending, raw, { encoding: 'utf8', flush: true });
    renameSync(pending, file);
    return true;
  } catch { return false; }
}

function trusted(event) {
  return event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(`${origin}/`);
}

function applyDisplay(win, mode, resolution) {
  if (!win || !resolutions.has(resolution) || (mode !== 'windowed' && mode !== 'borderless')) return false;
  if (mode === 'borderless') win.setFullScreen(true);
  else {
    win.setFullScreen(false);
    const [w, h] = resolution === 'auto' ? [1280, 800] : resolution.split('x').map(Number);
    const { workAreaSize } = screen.getDisplayMatching(win.getBounds());
    win.setContentSize(Math.min(w, workAreaSize.width - 24), Math.min(h, workAreaSize.height - 72));
    win.center();
  }
  return true;
}

async function serve(request) {
  try {
    const url = new URL(request.url);
    if (url.host !== 'game' || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response(null, { status: 404 });
    const route = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = resolve(bundle, `.${route}`);
    const name = relative(bundle, file);
    if (!name || name.startsWith('..') || isAbsolute(name)) return new Response(null, { status: 404 });
    const response = await net.fetch(pathToFileURL(file).href);
    if (name !== 'index.html') return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; object-src 'none'; frame-src 'none'");
    return new Response(response.body, { status: response.status, headers });
  } catch { return new Response(null, { status: 404 }); }
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'Tower Defense Demo', width: 1280, height: 800, minWidth: 680, minHeight: 480,
    backgroundColor: '#141b23', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
  try {
    const settings = JSON.parse(readProfile() ?? 'null')?.settings;
    if (settings) applyDisplay(win, settings.windowMode ?? 'windowed', settings.resolution);
  } catch { /* The renderer handles invalid profiles with defaults. */ }
  const query = app.commandLine.hasSwitch('td-benchmark') ? '?debug&stress&notactical' : '';
  void win.loadURL(`${origin}/${query}`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(() => {
  protocol.handle('td', serve);
  ipcMain.on('td:profile:read', (event) => { event.returnValue = trusted(event) ? readProfile() : null; });
  ipcMain.on('td:profile:write', (event, raw) => { event.returnValue = trusted(event) && writeProfile(raw); });
  ipcMain.handle('td:display', (event, mode, resolution) => trusted(event) &&
    applyDisplay(BrowserWindow.fromWebContents(event.sender), mode, resolution));
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  createWindow();
});
