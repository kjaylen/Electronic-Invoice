/**
 * Updates for the installed desktop till (electron-updater), from the server the till is paired with:
 * <server>/downloads/till/ (TILL_DOWNLOADS_DIR on the server).
 *
 * - The till page asks (window.tillDesktop.updates.check) when it starts and every few hours.
 * - A newer version downloads in the background while the till keeps selling.
 * - It is installed when someone chooses "Restart to update", or else when the app is closed: never in
 *   the middle of a sale. Sales are kept in the app's data folder, which an update does not touch.
 * - Signed builds (WIN_PUBLISHER_NAME) accept only an update signed with the same name. The update's
 *   SHA-512 from latest.yml is checked either way.
 */

const { app } = require('electron');

let autoUpdater = null;
let state = { status: 'idle', version: null, percent: null, error: null };
let listener = () => {};
let feed = null;

/** Only https, or http to this computer (trying a release locally). */
function feedFor(server) {
  let url;
  try {
    url = new URL(String(server));
  } catch {
    return null;
  }
  const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !local) return null;
  return new URL('downloads/till/', `${url.origin}${url.pathname.replace(/\/?$/, '/')}`).toString();
}

function set(next) {
  state = { ...state, ...next };
  listener(state);
}

function load() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info() {}, warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug() {} };
  autoUpdater.on('checking-for-update', () => state.status !== 'ready' && set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', version: null, percent: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('error', (e) => set({ status: state.status === 'ready' ? 'ready' : 'error', error: String(e?.message ?? e).slice(0, 300) }));
  return autoUpdater;
}

module.exports = {
  onStatus(fn) {
    listener = fn;
  },
  state: () => state,
  /** Look for an update on this server. Nothing happens in development, or while one is on its way. */
  async check(server) {
    if (!app.isPackaged && !process.env.TILL_UPDATE_TEST) return { ...state, status: 'unavailable' };
    const url = feedFor(server);
    if (!url) return { ...state, status: 'error', error: 'The server address cannot be used for updates' };
    if (state.status === 'downloading' || state.status === 'ready') return state;
    const updater = load();
    if (url !== feed) {
      updater.setFeedURL({ provider: 'generic', url });
      feed = url;
    }
    try {
      await updater.checkForUpdates();
    } catch (e) {
      set({ status: 'error', error: String(e?.message ?? e).slice(0, 300) });
    }
    return state;
  },
  /** Close and install the update that is ready, then open the new version. */
  install() {
    if (state.status !== 'ready' || !autoUpdater) return false;
    // Silently, into the folder it was installed in, and the new version opens.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  },
};
