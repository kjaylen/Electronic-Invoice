/**
 * One of every email the platform sends, to look at: npm run mail:proof
 *
 * Starts a mail catcher, runs the tests that send email with their mail
 * mirrored to it by SMTP (the tests trigger each email the way a person or
 * the background jobs do, with real data), and then says, for every type in
 * src/mail/types.ts, whether one arrived, from whom, with an HTML and a
 * plain-text part, and with what attached.
 *
 * The catcher's page stays up afterwards to read them one by one:
 *   http://localhost:1080   (MAIL_CATCH_VIEW_PORT to change it; --exit to stop when done)
 *
 * Nothing is delivered to anyone: the catcher keeps what it is given.
 */

import { spawn } from 'node:child_process';
import { MAIL_TYPES } from '../src/mail/types.ts';
import { startMailCatcher, startMailViewer } from '../test/mail-catcher.ts';

const catcher = await startMailCatcher({ port: Number(process.env.MAIL_CATCH_PORT ?? 0), ...(process.env.MAIL_CATCH_DIR && { dir: process.env.MAIL_CATCH_DIR }) });
const viewer = await startMailViewer(catcher, Number(process.env.MAIL_CATCH_VIEW_PORT ?? 1080));
console.log(`Catching on smtp://127.0.0.1:${catcher.port}; look at http://localhost:${viewer.port}`);

// Every test file that sends email (found by what it uses), run with its mail mirrored here.
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const args = ['--disable-warning=ExperimentalWarning', '--test', ...(files.length ? files : ['test/**/*.test.ts'])];
const code = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, MAIL_MIRROR_SMTP: `smtp://127.0.0.1:${catcher.port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  let failed = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (/^not ok /.test(line)) {
        failed++;
        console.log(line);
      }
    }
  });
  child.on('close', (c) => resolve(c ?? failed));
});

const byType = new Map<string, typeof catcher.mails>();
for (const m of catcher.mails) {
  const type = m.headers['x-floreo-type'] ?? '(none)';
  byType.set(type, [...(byType.get(type) ?? []), m]);
}
console.log(`\n${catcher.mails.length} emails caught. One of each kind:\n`);
const missing: string[] = [];
const flawed: string[] = [];
for (const [type, def] of Object.entries(MAIL_TYPES)) {
  const mails = byType.get(type) ?? [];
  const m = mails.find((x) => x.html) ?? mails[0];
  if (!m) {
    missing.push(type);
    console.log(`  MISSING  ${type.padEnd(24)} ${def.label}`);
    continue;
  }
  const problems = [
    ...(!m.html ? ['no HTML part'] : []),
    ...(!m.text.trim() ? ['no plain-text part'] : []),
    ...(m.html && !/<meta name="viewport"|max-width:\s*\d+px/.test(m.html) ? ['not sized for a phone'] : []),
    ...(/\bundefined\b|\[object Object\]|\{\{|\}\}/.test(`${m.subject}\n${m.text}`) ? ['an unfilled value in the text'] : []),
    ...(def.category === 'optional' && !m.headers['list-unsubscribe'] && !/unsubscribe/i.test(m.text) ? ['no way to stop it'] : []),
  ];
  if (problems.length) flawed.push(type);
  console.log(`  ${problems.length ? 'CHECK  ' : 'ok     '}  ${type.padEnd(24)} ${String(mails.length).padStart(3)}×  http://localhost:${viewer.port}/m/${m.id}  ${m.subject.slice(0, 60)}${m.attachments.length ? `  [${m.attachments.map((a) => a.filename).join(', ')}]` : ''}${problems.length ? `  <- ${problems.join('; ')}` : ''}`);
}
const unknown = [...byType.keys()].filter((t) => !(t in MAIL_TYPES));
if (unknown.length) console.log(`\nCaught with a type not in the catalogue: ${unknown.join(', ')}`);
console.log(`\n${Object.keys(MAIL_TYPES).length - missing.length} of ${Object.keys(MAIL_TYPES).length} kinds arrived${missing.length ? `; missing: ${missing.join(', ')}` : ''}${flawed.length ? `; to check: ${flawed.join(', ')}` : ''}. Tests ${code === 0 ? 'passed' : 'had failures'}.`);
if (process.argv.includes('--exit')) {
  await viewer.close();
  await catcher.close();
  process.exit(missing.length || flawed.length || code ? 1 : 0);
}
console.log(`The page stays up at http://localhost:${viewer.port} — press Ctrl+C to stop.`);
