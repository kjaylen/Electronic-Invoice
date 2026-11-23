/**
 * The business's logo for receipt printers: fetched once per address (an image's address never
 * changes), scaled to fit the paper, and turned into black-and-white dots (Atkinson dithering keeps
 * flat logos crisp and gives photos some shading). The ticket also keeps a picture for system printers.
 */

/** The ticket line this makes (structurally TicketImage in ticket.ts; no import, so Node can load this file in tests). */
type TicketImage = { kind: 'image'; width: number; height: number; bits: Uint8Array; src: string };

/** Dots across: fits a 58 mm printer (384 dots) and sits well on 80 mm (576). */
const MAX_WIDTH = 320;
const MAX_HEIGHT = 140;

const cache = new Map<string, Promise<TicketImage | null>>();

export function ticketLogo(url: string, fetchBlob: (url: string) => Promise<Blob>): Promise<TicketImage | null> {
  let logo = cache.get(url);
  if (!logo) {
    logo = load(url, fetchBlob).catch(() => {
      // Try again next time (the network may be back); print without it now.
      cache.delete(url);
      return null;
    });
    cache.set(url, logo);
  }
  return logo;
}

async function load(url: string, fetchBlob: (url: string) => Promise<Blob>): Promise<TicketImage | null> {
  const blob = await fetchBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    const scale = Math.min(MAX_WIDTH / img.naturalWidth, MAX_HEIGHT / img.naturalHeight, 2);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff'; // transparent parts print as paper
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    const bits = dither(g.getImageData(0, 0, width, height).data, width, height);
    return { kind: 'image', width, height, bits, src: canvas.toDataURL('image/png') };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** RGBA to 1-bit rows (MSB first, 1 = black), Atkinson dithering. */
export function dither(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  const rowBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(rowBytes * height);
  const spread = (x: number, y: number, e: number) => {
    if (x >= 0 && x < width && y < height) gray[y * width + x]! += e;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const old = gray[y * width + x]!;
      const black = old < 128;
      if (black) bits[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
      const e = (old - (black ? 0 : 255)) / 8;
      spread(x + 1, y, e); spread(x + 2, y, e); spread(x - 1, y + 1, e); spread(x, y + 1, e); spread(x + 1, y + 1, e); spread(x, y + 2, e);
    }
  }
  return bits;
}
