import { describe, expect, it } from "vitest";
import {
  CANVAS_GAP,
  DEVICE_CATALOG,
  DEVICE_CLASSES,
  FRAME_MIN_W,
  classDefaultZoom,
  customSizeModel,
  defaultDevicesState,
  dimsFor,
  effectiveScale,
  frameOuterSize,
  frameTitle,
  layoutUnplacedFrames,
  mergeCatalog,
  modelsForGroup,
  naturalOrientation,
  newFrame,
  normalizeTargetUrl,
  NAV_REPOINT_GRACE_MS,
  NavSyncTracker,
  storableTargetUrl,
  urlOrigin,
  packPosition,
  parseCustomDevices,
  parseStoredDevicesState,
  rearrangeFrames,
  stepGlobalZoom,
  stepZoom,
  type DeviceModel,
} from "./devices.js";

describe("DEVICE_CATALOG", () => {
  it("has unique ids and labels, positive dims", () => {
    const ids = new Set(DEVICE_CATALOG.map((m) => m.id));
    const labels = new Set(DEVICE_CATALOG.map((m) => m.label));
    expect(ids.size).toBe(DEVICE_CATALOG.length);
    expect(labels.size).toBe(DEVICE_CATALOG.length);
    for (const m of DEVICE_CATALOG) {
      expect(m.width).toBeGreaterThan(0);
      expect(m.height).toBeGreaterThan(0);
      expect(DEVICE_CLASSES).toContain(m.class);
    }
  });

  it("covers all five built-in classes", () => {
    const classes = new Set(DEVICE_CATALOG.map((m) => m.class));
    for (const c of [
      "Mobile",
      "Tablet",
      "Laptop",
      "Small Desktop",
      "Large Desktop",
    ]) {
      expect(classes).toContain(c);
    }
  });

  it("mobile/tablet models are portrait-first, desktop classes landscape-first", () => {
    for (const m of DEVICE_CATALOG) {
      if (m.class === "Mobile" || m.class === "Tablet") {
        expect(m.height).toBeGreaterThan(m.width);
        expect(naturalOrientation(m)).toBe("portrait");
      } else {
        expect(m.width).toBeGreaterThan(m.height);
        expect(naturalOrientation(m)).toBe("landscape");
      }
    }
  });
});

describe("dimsFor", () => {
  it("landscape swaps a portrait model's dims", () => {
    expect(
      dimsFor({ width: 402, height: 874, orientation: "landscape" }),
    ).toEqual({ width: 874, height: 402 });
  });

  it("rotating twice restores the original dims", () => {
    const start = { width: 402, height: 874, orientation: "portrait" as const };
    const once = dimsFor({ ...start, orientation: "landscape" });
    const twice = dimsFor({ ...once, orientation: "portrait" });
    expect(twice).toEqual({ width: 402, height: 874 });
  });

  it("desktop model in its natural landscape is unchanged", () => {
    expect(
      dimsFor({ width: 1920, height: 1080, orientation: "landscape" }),
    ).toEqual({ width: 1920, height: 1080 });
  });
});

describe("parseCustomDevices", () => {
  it("returns [] for undefined / blank / boolean / bad JSON", () => {
    expect(parseCustomDevices(undefined)).toEqual([]);
    expect(parseCustomDevices("")).toEqual([]);
    expect(parseCustomDevices("   ")).toEqual([]);
    expect(parseCustomDevices(true)).toEqual([]);
    expect(parseCustomDevices("{not json")).toEqual([]);
    expect(parseCustomDevices('{"label":"x"}')).toEqual([]);
  });

  it("keeps only valid entries, trims labels, rounds dims", () => {
    const out = parseCustomDevices(
      JSON.stringify([
        { label: "  Kiosk ", width: 1080.4, height: 1920.6 },
        { label: "", width: 100, height: 100 },
        { label: "NoDims" },
        { label: "Neg", width: -5, height: 100 },
        42,
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "custom:Kiosk",
      label: "Kiosk",
      class: "Custom",
      width: 1080,
      height: 1921,
    });
  });

  it("respects a valid class and defaults an invalid one to Custom", () => {
    const out = parseCustomDevices(
      JSON.stringify([
        { label: "Fold", width: 344, height: 882, class: "Tablet" },
        { label: "Weird", width: 500, height: 500, class: "Spaceship" },
      ]),
    );
    expect(out[0]!.class).toBe("Tablet");
    expect(out[1]!.class).toBe("Custom");
  });
});

describe("mergeCatalog", () => {
  const custom: DeviceModel[] = [
    { id: "custom:Kiosk", label: "Kiosk", class: "Custom", width: 1080, height: 1920 },
    { id: "custom:iPhone SE", label: "iPhone SE", class: "Mobile", width: 320, height: 568 },
  ];

  it("appends new customs and replaces a duplicate-label builtin in place", () => {
    const merged = mergeCatalog(DEVICE_CATALOG, custom);
    expect(merged).toHaveLength(DEVICE_CATALOG.length + 1);
    const se = merged.find((m) => m.label === "iPhone SE")!;
    expect(se.width).toBe(320);
    expect(merged.indexOf(se)).toBe(
      DEVICE_CATALOG.findIndex((m) => m.label === "iPhone SE"),
    );
    expect(merged.at(-1)!.label).toBe("Kiosk");
  });

  it("empty custom leaves the builtin catalog unchanged", () => {
    expect(mergeCatalog(DEVICE_CATALOG, [])).toEqual(DEVICE_CATALOG);
  });
});

describe("zoom helpers", () => {
  it("stepZoom moves along the steps and clamps at both ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });

  it("stepZoom snaps an off-step value to the nearest step first", () => {
    expect(stepZoom(0.9, 1)).toBe(1.25);
    expect(stepZoom(0.9, -1)).toBe(0.75);
  });

  it("stepGlobalZoom clamps to [25, 200]", () => {
    expect(stepGlobalZoom(100, 1)).toBe(110);
    expect(stepGlobalZoom(30, -1)).toBe(25);
    expect(stepGlobalZoom(195, 1)).toBe(200);
  });

  it("effectiveScale multiplies frame and global zoom, never ≤ 0", () => {
    expect(effectiveScale({ zoom: 0.5 }, 100)).toBe(0.5);
    expect(effectiveScale({ zoom: 1 }, 50)).toBe(0.5);
    expect(effectiveScale({ zoom: 0 }, 100)).toBeGreaterThan(0);
  });
});

describe("normalizeTargetUrl", () => {
  it("adds http:// when the scheme is missing and trims", () => {
    expect(normalizeTargetUrl("  localhost:5173 ")).toBe(
      "http://localhost:5173",
    );
  });

  it("keeps http(s) as-is", () => {
    expect(normalizeTargetUrl("https://app.test/x")).toBe("https://app.test/x");
    expect(normalizeTargetUrl("http://localhost:7878")).toBe(
      "http://localhost:7878",
    );
  });

  it("rejects non-web schemes", () => {
    expect(normalizeTargetUrl("javascript:alert(1)")).toBe("");
    expect(normalizeTargetUrl("data:text/html,hi")).toBe("");
    expect(normalizeTargetUrl("chrome-extension://abc/x.html")).toBe("");
    expect(normalizeTargetUrl("file:///c:/x.html")).toBe("");
    expect(normalizeTargetUrl("")).toBe("");
  });
});

describe("newFrame", () => {
  it("snapshots dims, applies class-default zoom, unique ids, nonce 0", () => {
    const model = DEVICE_CATALOG.find((m) => m.id === "desktop-qhd")!;
    const a = newFrame(model);
    const b = newFrame(model);
    expect(a.id).not.toBe(b.id);
    expect(a.width).toBe(2560);
    expect(a.height).toBe(1440);
    expect(a.orientation).toBe("landscape");
    expect(a.zoom).toBe(classDefaultZoom("Large Desktop"));
    expect(a.nonce).toBe(0);
  });

  it("frameTitle reflects orientation", () => {
    const model = DEVICE_CATALOG.find((m) => m.id === "iphone-16-pro")!;
    const f = newFrame(model);
    expect(frameTitle(f)).toBe("iPhone 16 Pro · 402×874");
    expect(frameTitle({ ...f, orientation: "landscape" })).toBe(
      "iPhone 16 Pro · 874×402",
    );
  });
});

describe("customSizeModel", () => {
  it("builds a Custom-class model with rounded dims", () => {
    expect(customSizeModel(480.4, 800.6)).toEqual({
      id: "size:480x801",
      label: "480×801",
      class: "Custom",
      width: 480,
      height: 801,
    });
  });

  it("rejects out-of-range and non-finite sizes", () => {
    expect(customSizeModel(199, 800)).toBeNull();
    expect(customSizeModel(480, 4001)).toBeNull();
    expect(customSizeModel(NaN, 800)).toBeNull();
    expect(customSizeModel(Infinity, 800)).toBeNull();
  });
});

describe("modelsForGroup", () => {
  it("returns every model of the class, and Desktops spans both desktop classes", () => {
    const mobile = modelsForGroup(DEVICE_CATALOG, "Mobile");
    expect(mobile.length).toBe(
      DEVICE_CATALOG.filter((m) => m.class === "Mobile").length,
    );
    const desktops = modelsForGroup(DEVICE_CATALOG, "Desktops");
    expect(desktops.map((m) => m.class)).toEqual(
      expect.arrayContaining(["Small Desktop", "Large Desktop"]),
    );
    expect(desktops.every((m) => m.class.endsWith("Desktop"))).toBe(true);
  });

  it("includes custom devices merged into a matching class", () => {
    const merged = mergeCatalog(DEVICE_CATALOG, [
      { id: "custom:Fold", label: "Fold", class: "Mobile", width: 344, height: 882 },
    ]);
    expect(modelsForGroup(merged, "Mobile").some((m) => m.label === "Fold")).toBe(true);
  });
});

describe("canvas layout", () => {
  const phone = DEVICE_CATALOG.find((m) => m.id === "iphone-16-pro")!;

  it("frameOuterSize enforces the card min width for small scaled frames", () => {
    const f = { ...newFrame(phone), zoom: 0.25 };
    const o = frameOuterSize(f, 100);
    expect(o.w).toBe(FRAME_MIN_W);
    expect(o.h).toBeGreaterThan(0);
  });

  it("layoutUnplacedFrames row-wraps within the viewport width", () => {
    const frames = [newFrame(phone), newFrame(phone), newFrame(phone)];
    // Viewport fits ~2 phone cards per row.
    const w = frameOuterSize(frames[0]!, 100).w;
    layoutUnplacedFrames(frames, 100, 2 * (w + CANVAS_GAP) + CANVAS_GAP);
    expect(frames[0]!.x).toBe(CANVAS_GAP);
    expect(frames[1]!.x).toBeGreaterThan(frames[0]!.x!);
    expect(frames[0]!.y).toBe(frames[1]!.y);
    expect(frames[2]!.x).toBe(CANVAS_GAP);
    expect(frames[2]!.y).toBeGreaterThan(frames[0]!.y!);
  });

  it("layoutUnplacedFrames masonry-fills free space and leaves placed frames alone", () => {
    // Placed frame sits far right — the new one takes the free top-left
    // spot instead of dropping below everything.
    const placed = { ...newFrame(phone), x: 500, y: 40 };
    const fresh = newFrame(phone);
    layoutUnplacedFrames([placed, fresh], 100, 5000);
    expect(placed.x).toBe(500);
    expect(placed.y).toBe(40);
    expect(fresh.x).toBe(CANVAS_GAP);
    expect(fresh.y).toBe(CANVAS_GAP);
  });

  it("packPosition opens a second column beside a tall frame", () => {
    const w = frameOuterSize(newFrame(phone), 100).w;
    const pos = packPosition([{ x: CANVAS_GAP, y: CANVAS_GAP, w, h: 900 }], w, 5000);
    expect(pos).toEqual({ x: CANVAS_GAP + w + CANVAS_GAP, y: CANVAS_GAP });
  });

  it("packPosition stacks below when nothing fits beside", () => {
    const w = frameOuterSize(newFrame(phone), 100).w;
    const pos = packPosition([{ x: CANVAS_GAP, y: CANVAS_GAP, w, h: 900 }], w, w + 2 * CANVAS_GAP);
    expect(pos).toEqual({ x: CANVAS_GAP, y: CANVAS_GAP + 900 + CANVAS_GAP });
  });

  it("rearrangeFrames re-packs everything without overlaps, from the top-left", () => {
    const frames = [
      { ...newFrame(phone), x: 900, y: 700 },
      { ...newFrame(phone), x: 40, y: 1200 },
      { ...newFrame(phone), x: 2000, y: 10 },
    ];
    rearrangeFrames(frames, 100, 5000);
    expect(frames[0]!.x).toBe(CANVAS_GAP);
    expect(frames[0]!.y).toBe(CANVAS_GAP);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i]!;
        const b = frames[j]!;
        const ao = frameOuterSize(a, 100);
        const bo = frameOuterSize(b, 100);
        const apart =
          a.x! + ao.w <= b.x! || b.x! + bo.w <= a.x! ||
          a.y! + ao.h <= b.y! || b.y! + bo.h <= a.y!;
        expect(apart).toBe(true);
      }
    }
  });
});

describe("parseStoredDevicesState", () => {
  it("garbage falls back to the default two-frame state", () => {
    for (const raw of [null, undefined, 42, "x", { frames: "nope" }, {}]) {
      const s = parseStoredDevicesState(raw);
      expect(s.frames).toHaveLength(2);
      expect(s.globalZoom).toBe(100);
      expect(s.url).toBe("");
      expect(s.sync).toBe(false);
    }
  });

  it("round-trips a valid state and clamps out-of-range zooms", () => {
    const stored = defaultDevicesState();
    stored.frames[0]!.zoom = 99;
    stored.globalZoom = 999;
    stored.url = "localhost:5173";
    stored.sync = true;
    const s = parseStoredDevicesState(JSON.parse(JSON.stringify(stored)));
    expect(s.frames).toHaveLength(2);
    expect(s.frames[0]!.zoom).toBeLessThanOrEqual(4);
    expect(s.globalZoom).toBe(200);
    expect(s.url).toBe("http://localhost:5173");
    expect(s.sync).toBe(true);
  });

  it("a frame with an unknown modelId survives via its dims snapshot", () => {
    const s = parseStoredDevicesState({
      frames: [
        {
          id: "f1",
          modelId: "custom:Gone",
          label: "Gone",
          width: 500,
          height: 700,
          orientation: "portrait",
          zoom: 1,
          nonce: 3,
        },
      ],
      globalZoom: 100,
      url: "",
    });
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]!.width).toBe(500);
    expect(s.frames[0]!.nonce).toBe(0);
  });

  it("keeps valid positions and treats negative ones as unplaced", () => {
    const base = {
      label: "X",
      width: 400,
      height: 800,
      orientation: "portrait",
      zoom: 1,
      nonce: 0,
    };
    const s = parseStoredDevicesState({
      frames: [
        { ...base, id: "a", modelId: "m", x: 10.6, y: 20 },
        { ...base, id: "b", modelId: "m", x: -5, y: 20 },
        { ...base, id: "c", modelId: "m" },
      ],
      globalZoom: 100,
      url: "",
    });
    expect(s.frames[0]!.x).toBe(11);
    expect(s.frames[0]!.y).toBe(20);
    expect(s.frames[1]!.x).toBeUndefined();
    expect(s.frames[2]!.x).toBeUndefined();
  });

  it("drops invalid frames and infers a missing orientation from dims", () => {
    const s = parseStoredDevicesState({
      frames: [
        { id: "", label: "bad", width: 100, height: 100 },
        { id: "ok", label: "Wide", width: 1920, height: 1080, zoom: 0.5 },
      ],
      globalZoom: 100,
      url: "",
    });
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]!.orientation).toBe("landscape");
  });
});

describe("nav sync", () => {
  const target = "http://localhost:5173/";

  it("urlOrigin / storableTargetUrl keep only http(s) origin (+ path)", () => {
    expect(urlOrigin("http://localhost:5173/a?b#c")).toBe("http://localhost:5173");
    expect(urlOrigin("javascript:alert(1)")).toBeNull();
    expect(storableTargetUrl("http://localhost:5173/course/1?token=abc#x")).toBe("http://localhost:5173/course/1");
    expect(storableTargetUrl("data:text/html,x")).toBe("");
  });

  it("first report is a position fix; a later same-origin change propagates", () => {
    const t = new NavSyncTracker();
    expect(t.report("a", "http://localhost:5173/", target, 0).verdict).toBe("record");
    expect(t.report("a", "http://localhost:5173/", target, 10).verdict).toBe("record");
    expect(t.report("a", "http://localhost:5173/b", target, 20)).toEqual({
      verdict: "propagate",
      url: "http://localhost:5173/b",
    });
  });

  it("never propagates cross-origin or non-http reports (forged by the framed page)", () => {
    const t = new NavSyncTracker();
    t.report("a", "http://localhost:5173/", target, 0);
    expect(t.report("a", "https://evil.test/phish", target, 10).verdict).toBe("record");
    expect(t.report("a", "javascript:alert(1)", target, 20).verdict).toBe("ignore");
  });

  it("re-pointed frames: reports inside the grace window stay local", () => {
    const t = new NavSyncTracker();
    t.report("b", "http://localhost:5173/", target, 0);
    t.markRepointed("b", 100, "http://localhost:5173/a");
    // Redirect after the sync re-point — must not bounce back.
    expect(t.report("b", "http://localhost:5173/login", target, 300).verdict).toBe("record");
    expect(t.report("b", "http://localhost:5173/next", target, 100 + NAV_REPOINT_GRACE_MS + 1).verdict).toBe(
      "propagate",
    );
  });

  it("a Pinta-initiated load clears the baseline; a user-initiated load keeps it", () => {
    const t = new NavSyncTracker();
    t.report("a", "http://localhost:5173/", target, 0);
    t.markRepointed("a", 0); // Refresh all
    t.loaded("a", 50);
    expect(t.urlOf("a")).toBeUndefined();
    expect(t.report("a", "http://localhost:5173/redirected", target, 60).verdict).toBe("record");
    // Later: user clicks a link in a multi-page app → full load, not expected.
    const later = 60 + NAV_REPOINT_GRACE_MS + 1;
    t.loaded("a", later);
    expect(t.report("a", "http://localhost:5173/page2", target, later + 10).verdict).toBe("propagate");
  });

  it("forget / clear drop state", () => {
    const t = new NavSyncTracker();
    t.report("a", "http://localhost:5173/", target, 0);
    t.forget("a");
    expect(t.urlOf("a")).toBeUndefined();
    t.report("b", "http://localhost:5173/", target, 0);
    t.clear();
    expect(t.urlOf("b")).toBeUndefined();
  });
});
