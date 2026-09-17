// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "@pinta/shared";
import {
  AGENT_IMAGE_MAX_EDGE,
  agentCropBand,
  annotationBoxes,
  compositeAnnotations,
  compositeOutputSize,
} from "./composite.js";

describe("compositeOutputSize", () => {
  it("caps a tall stitched page to the agent edge, keeping aspect ratio", () => {
    const out = compositeOutputSize(1280, 16384);
    expect(AGENT_IMAGE_MAX_EDGE).toBe(1568);
    expect(out.height).toBe(1568);
    expect(out.width).toBe(Math.round(1280 * (1568 / 16384)));
    expect(out.scale).toBeCloseTo(1568 / 16384, 10);
  });

  it("caps a wide image on its width", () => {
    const out = compositeOutputSize(3200, 1800);
    expect(out).toEqual({ width: 1568, height: Math.round(1800 * 0.49), scale: 0.49 });
  });

  it("maps annotation coordinates with the same scale as the pixels", () => {
    const out = compositeOutputSize(1440, 9000);
    // A mark at the bottom-right corner of the source lands on the output's.
    expect(1440 * out.scale).toBeCloseTo(out.width, 0);
    expect(9000 * out.scale).toBeCloseTo(out.height, 0);
  });

  it("never upscales an image already within the cap", () => {
    expect(compositeOutputSize(1280, 800)).toEqual({ width: 1280, height: 800, scale: 1 });
    expect(compositeOutputSize(1568, 1568)).toEqual({ width: 1568, height: 1568, scale: 1 });
  });

  it("treats Infinity / 0 / NaN as no cap (full-size exports)", () => {
    for (const cap of [Infinity, 0, -5, Number.NaN]) {
      expect(compositeOutputSize(1280, 16384, cap)).toEqual({ width: 1280, height: 16384, scale: 1 });
    }
  });

  it("keeps each side at least 1 px", () => {
    const out = compositeOutputSize(2, 100000, 1568);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1568);
    expect(compositeOutputSize(0, 0)).toEqual({ width: 1, height: 1, scale: 1 });
  });
});

const box = (y: number, height = 40) => ({ x: 10, y, width: 200, height });

describe("agentCropBand (F48: tall pages stay legible)", () => {
  it("crops a 6000px page to the annotated band plus a viewport of context", () => {
    const band = agentCropBand(6000, [box(3000), box(3200, 100)], 900);
    expect(band).toEqual({ y: 2100, height: 3300 + 900 - 2100 });
    // Legibility: the band is far shorter than the page, so the 1568 cap
    // shrinks it much less (scale ~0.37 vs ~0.26 for the whole page).
    expect(compositeOutputSize(1280, band!.height).scale).toBeGreaterThan(
      compositeOutputSize(1280, 6000).scale,
    );
  });

  it("clamps the padding at the page edges", () => {
    expect(agentCropBand(8000, [box(100)], 900)).toEqual({ y: 0, height: 1040 });
    expect(agentCropBand(8000, [box(7950, 50)], 900)).toEqual({ y: 7050, height: 950 });
  });

  it("keeps at least 600px of context when the viewport height is unknown", () => {
    expect(agentCropBand(8000, [box(4000)], 0)).toEqual({ y: 3400, height: 1240 });
    expect(agentCropBand(8000, [box(4000)], Number.NaN)).toEqual({ y: 3400, height: 1240 });
  });

  it("falls back to the whole page when annotations span it or there are none", () => {
    expect(agentCropBand(6000, [box(200), box(5700)], 900)).toBeNull();
    expect(agentCropBand(1500, [box(700)], 900)).toBeNull();
    expect(agentCropBand(6000, [], 900)).toBeNull();
  });
});

describe("annotationBoxes", () => {
  const rect = { x: 1, y: 50, width: 10, height: 10 };
  it("collects every painted rect per kind", () => {
    expect(annotationBoxes({ kind: "note" } as Annotation)).toEqual([]);
    expect(annotationBoxes({ kind: "select", target: { boundingRect: rect } } as unknown as Annotation)).toEqual([rect]);
    const dest = { x: 0, y: 900, width: 5, height: 5 };
    expect(
      annotationBoxes({
        kind: "move",
        target: { boundingRect: rect },
        move: { drop: "free", destinationRect: dest },
      } as unknown as Annotation),
    ).toEqual([rect, dest]);
    const r2 = { ...rect, y: 400 };
    expect(
      annotationBoxes({ kind: "delete", targets: [{ boundingRect: rect }, { boundingRect: r2 }] } as unknown as Annotation),
    ).toEqual([rect, r2]);
    expect(
      annotationBoxes({ kind: "arrow", strokes: [{ x: 5, y: 300 }, { x: 45, y: 100 }] } as unknown as Annotation),
    ).toEqual([{ x: 5, y: 100, width: 40, height: 200 }]);
  });
});

describe("compositeAnnotations crop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stub(w: number, h: number) {
    class FakeImage {
      naturalWidth = w;
      naturalHeight = h;
      decoding = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {}
      decode() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const calls: { op: string; args: unknown[] }[] = [];
    const canvas = { width: 0, height: 0 } as Record<string, unknown>;
    const rec = (op: string) => (...args: unknown[]) => void calls.push({ op, args });
    const ctx = new Proxy(
      { measureText: () => ({ width: 10 }) } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : rec(String(k))), set: () => true },
    );
    canvas.getContext = () => ctx;
    canvas.toBlob = (cb: (b: Blob) => void) => cb(new Blob(["x"], { type: "image/jpeg" }));
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : realCreate(tag)) as typeof document.createElement);
    return { calls, canvas };
  }

  const sel = (y: number) =>
    ({ kind: "select", target: { boundingRect: { x: 10, y, width: 100, height: 40 } } }) as unknown as Annotation;

  it("agent path draws only the band and shifts marks by the crop offset", async () => {
    const { calls } = stub(1280, 6000);
    await compositeAnnotations("data:,", [sel(3000)], { cropToAnnotations: { viewportHeight: 800 } });
    // band = 2200..3840 (1640 tall) -> capped to 1568 on the long edge.
    expect(calls.find((c) => c.op === "drawImage")!.args.slice(1)).toEqual([
      0, 2200, 1280, 1640, 0, 0, 1224, 1568,
    ]);
    expect(calls.find((c) => c.op === "translate")!.args).toEqual([0, -2200]);
  });

  it("without the crop option the whole page is drawn and nothing is translated", async () => {
    const { calls } = stub(1280, 6000);
    await compositeAnnotations("data:,", [sel(3000)], { maxLongEdge: Infinity });
    expect(calls.find((c) => c.op === "drawImage")!.args.slice(1, 5)).toEqual([0, 0, 1280, 6000]);
    expect(calls.some((c) => c.op === "translate")).toBe(false);
  });
});
