/**
 * Pictures made ready to upload, in the browser: a photo straight from a
 * phone (several megabytes, four thousand pixels across) is scaled down and
 * compressed before it is sent, so it is accepted, uploads quickly on a slow
 * connection, and loads quickly for customers. Small pictures, SVGs and
 * animated GIFs go as they are.
 */

export interface PreparedImage { name: string; dataBase64: string; bytes: number }

/** Thrown with a message meant for the person uploading. */
export class ImageProblem extends Error {
  override name = 'ImageProblem';
}

const SMALL_ENOUGH = 500 * 1024;
const SIDES = [2000, 1600, 1200, 900];
const QUALITIES = [0.85, 0.72];

const base64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
  r.readAsDataURL(blob);
});

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      // Turned the way the camera held it.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* fall through to an <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** The extension a name should have for a type. */
const renamed = (name: string, type: string) => `${name.replace(/\.[^.]*$/, '') || 'image'}.${type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'}`;

/**
 * `file` ready to upload within `maxBytes`: as it is when it is small (or an SVG or GIF), otherwise
 * scaled to at most `maxSide` pixels and compressed (JPEG for photos; WebP, or PNG where the browser
 * cannot make WebP, for pictures that may be see-through).
 */
export async function prepareImage(file: File, opts: { maxBytes: number; maxSide?: number }): Promise<PreparedImage> {
  const name = file.name.replace(/[^\w.-]+/g, '-').slice(-100) || 'image';
  const asIs = async () => ({ name, dataBase64: await base64(file), bytes: file.size });
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    if (file.size > opts.maxBytes) throw new ImageProblem('That file is too large. Use a smaller one.');
    return asIs();
  }
  if (file.size <= Math.min(SMALL_ENOUGH, opts.maxBytes)) return asIs();
  let picture;
  try {
    picture = await decode(file);
  } catch {
    if (file.size <= opts.maxBytes) return asIs();
    throw new ImageProblem('That file could not be read as a picture. Use a JPEG or PNG.');
  }
  try {
    const type = file.type === 'image/png' || file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const canvas = document.createElement('canvas');
    const longest = Math.max(picture.width, picture.height);
    for (const side of [opts.maxSide ?? SIDES[0]!, ...SIDES].filter((s, i, all) => all.indexOf(s) === i && s <= (opts.maxSide ?? SIDES[0]!))) {
      const scale = Math.min(1, side / longest);
      canvas.width = Math.max(1, Math.round(picture.width * scale));
      canvas.height = Math.max(1, Math.round(picture.height * scale));
      const g = canvas.getContext('2d');
      if (!g) break;
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        // A browser that cannot make the type asked for answers with a PNG.
        const blob = await toBlob(canvas, type, quality);
        if (!blob || blob.size > opts.maxBytes) continue;
        // Not worth it if it came out no smaller and the original would do.
        if (blob.size >= file.size && file.size <= opts.maxBytes && scale === 1) return asIs();
        return { name: renamed(name, blob.type), dataBase64: await base64(blob), bytes: blob.size };
      }
    }
  } finally {
    picture.close();
  }
  if (file.size <= opts.maxBytes) return asIs();
  throw new ImageProblem('That picture is too large, even after making it smaller. Try another one.');
}
