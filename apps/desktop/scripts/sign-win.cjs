/**
 * Signs one Windows file for electron-builder (electron-builder.config.cjs), with a timestamp so the
 * signature stays valid after the certificate expires.
 *
 *   WIN_SIGN_THUMBPRINT=<sha1>       signtool, the certificate from the Windows certificate store
 *   WIN_SIGN_COMMAND="tool ... {file}"   any signing tool; {file} is replaced by the file, quoted
 *   WIN_SIGN_TIMESTAMP_URL           default http://timestamp.digicert.com
 *   SIGNTOOL                         signtool.exe, when it is not in a Windows SDK in the usual place
 */

const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function signtool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse() : [];
  for (const v of versions) {
    const exe = path.join(kits, v, 'x64', 'signtool.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('signtool.exe not found: install the Windows SDK, or set SIGNTOOL');
}

module.exports = async function sign(configuration) {
  const file = configuration.path;
  if (configuration.hash && configuration.hash !== 'sha256') return;
  const timestamp = process.env.WIN_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  if (process.env.WIN_SIGN_COMMAND) {
    execSync(process.env.WIN_SIGN_COMMAND.replaceAll('{file}', `"${file}"`), { stdio: 'inherit' });
  } else if (process.env.WIN_SIGN_THUMBPRINT) {
    execFileSync(signtool(), ['sign', '/sha1', process.env.WIN_SIGN_THUMBPRINT.replace(/\s/g, ''), '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256', file], { stdio: 'inherit' });
  } else {
    return;
  }
  console.log(`  signed ${path.basename(file)}`);
};
