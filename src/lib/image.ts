/** On-device image preparation: honour EXIF rotation, cap the size, re-encode as JPEG. */
const FULL_EDGE = 2560;
const THUMB_EDGE = 480;

export interface PreparedImage {
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

async function encode(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const k = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * k);
  const height = Math.round(bitmap.height * k);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }), width, height };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
  return { blob, width, height };
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("This image format can't be read on this device.");
  }
  try {
    const full = await encode(bitmap, FULL_EDGE, 0.86);
    const thumb = await encode(bitmap, THUMB_EDGE, 0.75);
    return { blob: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
  } finally {
    bitmap.close();
  }
}

/** Thumbnail for an image downloaded from the repository (kept as-is). */
export async function thumbnailFor(blob: Blob): Promise<{ thumb: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const t = await encode(bitmap, THUMB_EDGE, 0.75);
    return { thumb: t.blob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
