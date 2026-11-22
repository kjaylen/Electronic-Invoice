/**
 * A small streaming ZIP writer (PKWARE APPNOTE 6.3, no ZIP64): each file is
 * compressed whole (they are small: signed XML, PDFs, a CSV), written with
 * its CRC and sizes known, and the central directory comes at the end.
 * Enough for archives of up to 65,535 files and 4 GB.
 */

import { PassThrough } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as ZIP stores them (local time of the archive's choosing). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

interface Entry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  method: number;
  date: number;
  time: number;
  offset: number;
}

export const MAX_ZIP_ENTRIES = 65_535;

export class ZipWriter {
  readonly stream = new PassThrough();
  #entries: Entry[] = [];
  #offset = 0;
  #names = new Set<string>();
  #closed = false;

  get count(): number {
    return this.#entries.length;
  }

  /** Add one file. `when` is shown as its date (UTC fields: pass Belize wall-clock time as UTC). Waits if the reader is slow. */
  async add(name: string, content: string | Uint8Array, when = new Date()): Promise<void> {
    if (this.#closed) throw new Error('The archive is already finished');
    if (this.#entries.length >= MAX_ZIP_ENTRIES) throw new Error('Too many files for one archive');
    if (this.#names.has(name)) throw new Error(`Duplicate file in archive: ${name}`);
    this.#names.add(name);
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const deflated = deflateRawSync(data, { level: 6 });
    // Already-compressed content (PDF streams) may not shrink: store it as is.
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const { date, time } = dosDateTime(when);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    if (this.#offset + header.length + nameBuf.length + body.length > 0xffffffff) throw new Error('The archive is too large');
    this.#entries.push({ name: nameBuf, crc, compressed: body.length, size: data.length, method, date, time, offset: this.#offset });
    await this.#write(Buffer.concat([header, nameBuf, body]));
  }

  /** Write the central directory and end the stream. */
  async finish(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const start = this.#offset;
    const parts: Buffer[] = [];
    for (const e of this.#entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0 (so the permissions below apply)
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
      h.writeUInt32LE(e.offset, 42);
      parts.push(h, e.name);
    }
    const directory = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.#entries.length, 8);
    end.writeUInt16LE(this.#entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(start, 16);
    await this.#write(Buffer.concat([directory, end]));
    this.stream.end();
  }

  /** Stop early (an error part-way): the reader sees the stream fail rather than a truncated "valid" file. */
  abort(err: Error): void {
    this.#closed = true;
    this.stream.destroy(err);
  }

  async #write(chunk: Buffer): Promise<void> {
    this.#offset += chunk.length;
    if (!this.stream.write(chunk)) await new Promise<void>((resolve, reject) => {
      const done = () => { this.stream.off('error', fail); resolve(); };
      const fail = (e: Error) => { this.stream.off('drain', done); reject(e); };
      this.stream.once('drain', done);
      this.stream.once('error', fail);
      this.stream.once('close', done);
    });
  }
}

/** Read a ZIP made by ZipWriter back (for tests and checks): name → content. */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const { inflateRawSync } = await import('node:zlib');
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(local, local + compressed);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
