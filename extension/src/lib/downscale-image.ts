// Downscale + JPEG-encode a pasted / dropped REFERENCE image before it
// rides on an annotation to the agent. Reference images are vision input,
// and vision tokens are the user's own Claude spend (BYO-Claude) — a 4 MB
// screenshot paste is thousands of tokens for a "make it look like this"
// hint. We cap the longest edge and re-encode as JPEG, but only keep the
// result when it actually shrinks the payload, and always fall back to the
// original data URL on any error (a big image beats no image).

const MAX_EDGE = 1600; // px — ample for a visual reference in a side panel
const JPEG_QUALITY = 0.82;
// Below this, re-encoding rarely helps and risks bloating a tiny PNG icon.
const SKIP_UNDER_BYTES = 200_000;

export type DownscaledImage = { dataUrl: string; mediaType: string };

const PNG_OR_JPEG = /^data:image\/(png|jpeg);base64,/;

/**
 * `pngOrJpeg`: the caller's wire only accepts PNG/JPEG data URLs, so when
 * the normal path would hand back an original GIF/WebP/etc. (small image,
 * or JPEG not smaller), re-encode it within the same edge cap — PNG when
 * the image has transparency, JPEG otherwise. Throws if it can't.
 */
export async function downscaleImage(
  blob: File | Blob,
  opts: { maxEdge?: number; pngOrJpeg?: boolean } = {},
): Promise<DownscaledImage> {
  const maxEdge = opts.maxEdge && opts.maxEdge > 0 ? opts.maxEdge : MAX_EDGE;
  const original = await blobToDataUrl(blob);
  const out = await downscaleDataUrl(original, blob.type || "image/png", maxEdge);
  if (!opts.pngOrJpeg || PNG_OR_JPEG.test(out.dataUrl)) return out;
  return await reencodePngOrJpeg(original, maxEdge);
}

async function reencodePngOrJpeg(src: string, maxEdge: number): Promise<DownscaledImage> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxEdge / (Math.max(img.naturalWidth, img.naturalHeight) || 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, w, h);
  const out = hasAlpha(ctx, w, h)
    ? { dataUrl: canvas.toDataURL("image/png"), mediaType: "image/png" }
    : { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), mediaType: "image/jpeg" };
  canvas.width = canvas.height = 0;
  if (!PNG_OR_JPEG.test(out.dataUrl)) throw new Error("unsupported image type");
  return out;
}

/** True when any pixel is not fully opaque (JPEG would matte it away). */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
    return false;
  } catch {
    return true; // can't inspect — PNG is the lossless-safe choice
  }
}

async function downscaleDataUrl(
  original: string,
  originalMedia: string,
  maxEdge: number,
): Promise<DownscaledImage> {
  try {
    const img = await loadImage(original);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = Math.min(1, maxEdge / (longest || 1));
    // Already small AND light — leave it untouched (keeps a crisp small
    // logo/icon rather than matting + JPEG-ing it).
    if (scale === 1 && original.length < SKIP_UNDER_BYTES) {
      return { dataUrl: original, mediaType: originalMedia };
    }
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl: original, mediaType: originalMedia };
    // White matte so a transparent source doesn't render black under JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const jpeg = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return jpeg.length < original.length
      ? { dataUrl: jpeg, mediaType: "image/jpeg" }
      : { dataUrl: original, mediaType: originalMedia };
  } catch {
    return { dataUrl: original, mediaType: originalMedia };
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}
