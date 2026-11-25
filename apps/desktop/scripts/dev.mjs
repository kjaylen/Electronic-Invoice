// The desktop till straight from the source, with nothing built: starts Vite on the web app and
// opens Electron on it. The app still runs at app://pos/ (the same origin as the installed till, so
// the server, the storage and the printers behave the same); its files come from Vite instead of a
// copy of web/dist. A change to a screen shows at once; Ctrl+R reloads, Ctrl+Shift+I opens the tools.
//
//   npm run till:dev                                   (at the repository root)
//   VITE_TILL_SERVER=http://localhost:4300 npm run till:dev    pre-fills the server on the pairing screen
//
// It keeps its own data folder ("Floreo Till (dev)"), so it never touches an installed till's pairing.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(appDir, '..', '..');

let electron;
try {
  electron = createRequire(join(appDir, 'package.json'))('electron');
} catch {
  console.error('Electron is not installed yet. Once:  cd apps/desktop && npm install');
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', 'vite'))) {
  console.error('Install the repository first:  npm install  (at the repository root)');
  process.exit(1);
}

const { createServer } = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vite')).href);
// A free port first, so the live-reload socket can be told where Vite is (the page itself is at app://pos/).
const { createServer: tcp } = await import('node:net');
const port = await new Promise((resolve) => { const s = tcp(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const vite = await createServer({
  configFile: join(root, 'web', 'vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true, ws: { protocol: 'ws', host: '127.0.0.1', clientPort: port }, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } },
  clearScreen: false,
});
await vite.listen();
const url = `http://127.0.0.1:${port}`;
console.log(`The till's screens are served from the source at ${url}. Opening the app…`);

const child = spawn(electron, [appDir], { stdio: 'inherit', env: { ...process.env, TILL_DEV_SERVER: url } });
const stop = async () => {
  await vite.close().catch(() => {});
  process.exit(0);
};
child.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); void stop(); });
