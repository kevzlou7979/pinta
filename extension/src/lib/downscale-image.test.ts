// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downscaleImage } from "./downscale-image.js";

// happy-dom can't decode images or rasterize a canvas, so stub both: the
// fake Image reports the size we choose, the fake canvas records the size
// it was given and "encodes" to a short JPEG data URL.
let nextSize = { w: 0, h: 0 };
let canvases: { width: number; height: number }[] = [];
let decodeFails = false;
let alpha = false;
let draws: number[][] = [];

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => {
      if (decodeFails) return this.onerror?.();
      this.naturalWidth = nextSize.w;
      this.naturalHeight = nextSize.h;
      this.onload?.();
    });
  }
}

const TINY_JPEG = "data:image/jpeg;base64,AAAA";
const TINY_PNG = "data:image/png;base64,BBBB";

beforeEach(() => {
  canvases = [];
  decodeFails = false;
  alpha = false;
  draws = [];
  vi.stubGlobal("Image", FakeImage);
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return realCreate(tag);
    const c = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect() {},
        drawImage: (_img: unknown, ...args: number[]) => void draws.push(args),
        fillStyle: "",
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha ? 128 : 255]) }),
      }),
      toDataURL: (type: string) =>
        type === "image/jpeg" ? TINY_JPEG : type === "image/png" ? TINY_PNG : "data:,",
    };
    canvases.push(c);
    return c;
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A PNG-typed blob of `bytes` bytes (content is irrelevant to the stubs). */
const pngBlob = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("downscaleImage", () => {
  it("default cap (no opts) stays at 1600 px — backward compatible", async () => {
    nextSize = { w: 3200, h: 1600 };
    const out = await downscaleImage(pngBlob(1000));
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 1600, height: 800 });
    expect(out).toEqual({ dataUrl: TINY_JPEG, mediaType: "image/jpeg" });
  });

  it("maxEdge caps the long edge (portrait) and keeps aspect ratio", async () => {
    nextSize = { w: 1200, h: 2400 };
    const out = await downscaleImage(pngBlob(1000), { maxEdge: 900 });
    expect(canvases[0]).toMatchObject({ width: 450, height: 900 });
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("ignores a non-positive maxEdge (falls back to the default)", async () => {
    nextSize = { w: 2000, h: 1000 };
    await downscaleImage(pngBlob(1000), { maxEdge: 0 });
    await downscaleImage(pngBlob(1000), { maxEdge: -10 });
    expect(canvases.map((c) => c.width)).toEqual([1600, 1600]);
  });

  it("never upscales: a small, light image is returned untouched", async () => {
    nextSize = { w: 300, h: 200 };
    const blob = pngBlob(100);
    const out = await downscaleImage(blob, { maxEdge: 900 });
    expect(canvases).toHaveLength(0);
    expect(out.mediaType).toBe("image/png");
    expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("keeps the original when the JPEG would not be smaller", async () => {
    nextSize = { w: 2000, h: 2000 };
    const original = await downscaleImage(pngBlob(1), { maxEdge: 900 });
    // A 1-byte PNG's data URL is shorter than any realistic JPEG, so make
    // the stub's JPEG longer than the original to hit keep-if-smaller.
    expect(canvases[0]).toMatchObject({ width: 900, height: 900 });
    expect(TINY_JPEG.length).toBeGreaterThan(original.dataUrl.length);
    expect(original.mediaType).toBe("image/png");
  });

  it("falls back to the original data URL when decoding fails", async () => {
    decodeFails = true;
    const out = await downscaleImage(pngBlob(10), { maxEdge: 900 });
    expect(out.mediaType).toBe("image/png");
    expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});

const typedBlob = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type });

describe("downscaleImage pngOrJpeg (F75: GIF/WebP reference paste)", () => {
  it("re-encodes a small opaque GIF to JPEG instead of returning the GIF", async () => {
    nextSize = { w: 120, h: 80 };
    const out = await downscaleImage(typedBlob(50, "image/gif"), { maxEdge: 900, pngOrJpeg: true });
    expect(out).toEqual({ dataUrl: TINY_JPEG, mediaType: "image/jpeg" });
    expect(canvases.at(-1)).toMatchObject({ width: 0, height: 0 }); // released after encode
  });

  it("keeps transparency: a small WebP with alpha becomes PNG", async () => {
    nextSize = { w: 64, h: 64 };
    alpha = true;
    const out = await downscaleImage(typedBlob(50, "image/webp"), { maxEdge: 900, pngOrJpeg: true });
    expect(out).toEqual({ dataUrl: TINY_PNG, mediaType: "image/png" });
  });

  it("re-encodes within the edge cap when the JPEG wasn't smaller", async () => {
    nextSize = { w: 2000, h: 1000 };
    const out = await downscaleImage(typedBlob(1, "image/gif"), { maxEdge: 900, pngOrJpeg: true });
    // First canvas: normal path (JPEG not smaller than a 1-byte GIF). Second: re-encode.
    expect(canvases).toHaveLength(2);
    expect(draws.at(-1)).toEqual([0, 0, 900, 450]);
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("PNG/JPEG results pass straight through; without the flag a GIF is left alone", async () => {
    nextSize = { w: 120, h: 80 };
    const png = await downscaleImage(pngBlob(50), { maxEdge: 900, pngOrJpeg: true });
    expect(png.mediaType).toBe("image/png");
    expect(canvases).toHaveLength(0);
    const gif = await downscaleImage(typedBlob(50, "image/gif"), { maxEdge: 900 });
    expect(gif.dataUrl.startsWith("data:image/gif;base64,")).toBe(true);
  });

  it("throws when an undecodable non-PNG/JPEG can't be re-encoded", async () => {
    decodeFails = true;
    await expect(
      downscaleImage(typedBlob(50, "image/gif"), { maxEdge: 900, pngOrJpeg: true }),
    ).rejects.toThrow();
  });
});
