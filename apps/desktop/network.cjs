/**
 * Sending raw bytes (ESC/POS) to a receipt printer on the local network,
 * usually on port 9100. Only to addresses on the local network: a till never
 * needs to open raw connections to the internet.
 */

const net = require('node:net');
const dns = require('node:dns/promises');

/** 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local), 127/8, and IPv6 local ranges. */
function isLocalAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isLocalAddress(v.slice(7));
    return v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd');
  }
  return false;
}

async function resolveLocal(host) {
  if (net.isIP(host)) {
    if (!isLocalAddress(host)) throw new Error(`${host} is not on the local network`);
    return host;
  }
  const { address } = await dns.lookup(host);
  if (!isLocalAddress(address)) throw new Error(`${host} is not on the local network`);
  return address;
}

/** Open, write everything, close; fail after a timeout so the till never hangs on a printer that is off. */
async function sendToPrinter(host, port, data, timeoutMs = 8000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid printer port');
  if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 4 * 1024 * 1024) throw new Error('Nothing to print');
  const address = await resolveLocal(String(host).trim());
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address, port });
    const fail = (e) => {
      socket.destroy();
      reject(new Error(e.code === 'ECONNREFUSED' ? `The printer at ${host}:${port} refused the connection` : e.message === 'timeout' ? `No answer from the printer at ${host}:${port}; is it on and connected?` : e.message));
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(Buffer.from(data)));
    socket.once('close', (hadError) => {
      if (!hadError) resolve();
    });
  });
}

module.exports = { sendToPrinter, isLocalAddress };
