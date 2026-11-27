/**
 * Floreo Till for Windows, macOS and Linux.
 *
 * The till itself is the web till (web/src/pos), bundled with the app and
 * served from app://pos/. This process gives it what a browser cannot:
 *   - printing ESC/POS straight to network receipt printers (and kicking the
 *     cash drawer plugged into them);
 *   - printing to installed (USB) printers without a dialog;
 *   - a customer display on a second screen;
 *   - storage for the till's token, encrypted with the OS keychain;
 *   - updates from the server it is paired with (updates.cjs).
 */

const { app, BrowserWindow, ipcMain, protocol, safeStorage, screen, shell, net: electronNet } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sendToPrinter } = require('./network.cjs');
const updates = require('./updates.cjs');

const WEB = path.join(__dirname, 'web');
const ORIGIN = 'app://pos';
// Development only (npm run till:dev): the screens come from a Vite server on this computer instead of
// the copy in web/. Never in an installed app.
const DEV = !app.isPackaged && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.TILL_DEV_SERVER ?? '') ? process.env.TILL_DEV_SERVER : null;
if (DEV) app.setPath('userData', path.join(app.getPath('appData'), 'Floreo Till (dev)'));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- storage ----------

const storeFile = () => path.join(app.getPath('userData'), 'till.json');
// Encrypted with the operating system's key: the till's token and the key of its local data.
const SECRET_KEYS = new Set(['till.token', 'till.dbkey']);
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeStore(data) {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}
const encrypt = (value) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value);
const decrypt = (value) => (typeof value === 'string' && value.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')) : value);

// ---------- windows ----------

let till = null;
let display = null;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; media-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'";

function serveApp() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // No Content-Security-Policy here: Vite's live reload needs inline scripts.
    if (DEV) {
      const accept = request.headers.get('accept');
      const res = await electronNet.fetch(`${DEV}${url.pathname === '/' ? '/pos.html' : url.pathname}${url.search}`, { ...(accept && { headers: { accept } }), bypassCustomProtocolHandlers: true });
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'pos.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    const res = await electronNet.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function lockDown(win) {
  // The till never navigates away from itself; links open in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media' || permission === 'clipboard-sanitized-write'));
}

function createTill() {
  till = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Floreo Till',
    backgroundColor: '#efe7d6',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--till-version=${app.getVersion()}`] },
  });
  lockDown(till);
  till.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') till.setFullScreen(!till.isFullScreen());
  });
  till.on('closed', () => {
    till = null;
    display?.close();
  });
  void till.loadURL(`${ORIGIN}/pos.html`);
}

function openDisplay() {
  if (display) return true;
  const primary = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
  display = new BrowserWindow({
    ...(other ? { x: other.bounds.x, y: other.bounds.y, width: other.bounds.width, height: other.bounds.height, fullscreen: true } : { width: 800, height: 480 }),
    title: 'Customer display',
    backgroundColor: '#160923',
    autoHideMenuBar: true,
    focusable: !other,
    webPreferences: { preload: path.join(__dirname, 'display-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(display);
  display.on('closed', () => {
    display = null;
  });
  void display.loadURL(`${ORIGIN}/display.html`);
  return true;
}

// ---------- printing ----------

/** An HTML ticket on an installed printer, without a dialog, sized to the roll. */
async function printHtml(html, options) {
  const win = new BrowserWindow({ show: false, width: 400, height: 800, webPreferences: { sandbox: true, javascript: false } });
  try {
    const file = path.join(app.getPath('temp'), `till-print-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    try {
      await win.loadFile(file);
    } finally {
      fs.rm(file, () => {});
    }
    const widthMm = options.widthMm === 58 ? 58 : 80;
    // How long the receipt is (the page runs no scripts, so ask the renderer's layout).
    const contentHeight = await new Promise((resolve) => {
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.sendCommand('Page.getLayoutMetrics').then((m) => resolve(m.cssContentSize?.height ?? m.contentSize.height)).catch(() => resolve(1200)).finally(() => {
        try {
          win.webContents.debugger.detach();
        } catch {
          /* already detached */
        }
      });
    });
    const heightMicrons = Math.max(100_000, Math.ceil((contentHeight * 25.4 * 1000) / 96) + 10_000);
    await new Promise((resolve, reject) => {
      win.webContents.print({
        silent: true,
        printBackground: true,
        ...(options.printer && { deviceName: options.printer }),
        margins: { marginType: 'none' },
        pageSize: { width: widthMm * 1000, height: heightMicrons },
      }, (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'The printer did not print'))));
    });
  } finally {
    win.destroy();
  }
}

// ---------- the bridge ----------

const fromTill = (event) => event.senderFrame?.url?.startsWith(`${ORIGIN}/`);
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromTill(event)) throw new Error('Not allowed');
    return fn(...args);
  });
}

handle('store:get', (key) => {
  const v = readStore()[String(key)];
  return v === undefined ? null : decrypt(v);
});
handle('store:set', (key, value) => {
  const data = readStore();
  data[String(key)] = SECRET_KEYS.has(key) ? encrypt(String(value)) : String(value);
  writeStore(data);
});
handle('store:remove', (key) => {
  const data = readStore();
  delete data[String(key)];
  writeStore(data);
});
handle('printers:list', async () => {
  const list = till ? await till.webContents.getPrintersAsync() : [];
  return list.map((p) => ({ name: p.name, isDefault: Boolean(p.isDefault) }));
});
handle('printers:printHtml', (html, options) => printHtml(String(html), options ?? {}));
handle('printers:sendNetwork', (host, port, data) => sendToPrinter(String(host), Number(port), data instanceof Uint8Array ? data : new Uint8Array(data)));
handle('display:open', () => openDisplay());
// Updates from the server the till is paired with (updates.cjs).
handle('updates:check', (server) => updates.check(server));
handle('updates:state', () => updates.state());
handle('updates:install', () => updates.install());
updates.onStatus((state) => till?.webContents.send('updates:status', state));

ipcMain.on('display:update', (event, state) => {
  if (fromTill(event)) display?.webContents.send('display:state', state);
});
ipcMain.on('display:close', (event) => {
  if (fromTill(event)) display?.close();
});

app.on('second-instance', () => {
  if (till) {
    if (till.isMinimized()) till.restore();
    till.focus();
  }
});
app.whenReady().then(() => {
  serveApp();
  createTill();
  app.on('activate', () => {
    if (!till) createTill();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
