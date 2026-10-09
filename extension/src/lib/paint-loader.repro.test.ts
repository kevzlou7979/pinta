// Tester (paint-loader-empty-states, item 1 + 2): contract tests for the
// three shared shells — PaintLoader (the one loader), EmptyState (the one
// empty state) and LoadingState (loader + line). Mounts each component in
// happy-dom through the svelte plugin (vitest.repro.config.ts).
import { describe, it, expect } from "vitest";
import { mount, unmount, flushSync, createRawSnippet } from "svelte";
import PaintLoader from "./PaintLoader.svelte";
import EmptyState from "./EmptyState.svelte";
import LoadingState from "./LoadingState.svelte";

const SIZES = ["xs", "sm", "md", "lg"] as const;
const HEIGHT = { xs: 14, sm: 20, md: 40, lg: 72 } as const;

function mountIn<T extends Record<string, any>>(Component: any, props: T) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const cmp = mount(Component, { target, props });
  flushSync();
  return { target, dispose: () => { unmount(cmp); target.remove(); } };
}

const snippet = (html: string) => createRawSnippet(() => ({ render: () => html }));

describe("PaintLoader", () => {
  // Fixer F1: xs/sm sit inside buttons, chips and lines that already own
  // the wait, so they default to DECORATIVE; md/lg default to a labelled
  // status region. `decorative` explicitly overrides either way.
  const DEFAULT_STATUS = { xs: false, sm: false, md: true, lg: true } as const;
  for (const size of SIZES) {
    it(`size=${size}: ${DEFAULT_STATUS[size] ? "labelled status region" : "decorative by default"}, SVG height ${HEIGHT[size]}px, overflow visible`, () => {
      const { target, dispose } = mountIn(PaintLoader, { size });
      const root = target.querySelector(".pinta-paint-loader")!;
      expect(root, "root .pinta-paint-loader").toBeTruthy();
      if (DEFAULT_STATUS[size]) {
        expect(root.getAttribute("role")).toBe("status");
        expect(root.getAttribute("aria-label")).toBe("Loading");
        expect(root.getAttribute("aria-hidden")).toBeNull();
      } else {
        expect(root.getAttribute("role")).toBeNull();
        expect(root.getAttribute("aria-label")).toBeNull();
        expect(root.getAttribute("aria-hidden")).toBe("true");
      }
      expect(root.getAttribute("data-size")).toBe(size);
      expect(root.getAttribute("data-tone")).toBe("paint");
      const svg = root.querySelector("svg")!;
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.getAttribute("viewBox")).toBe("0 0 48 48");
      // Square ring — width === height === the size's diameter.
      expect(Number(svg.getAttribute("height"))).toBe(HEIGHT[size]);
      expect(Number(svg.getAttribute("width"))).toBe(HEIGHT[size]);
      dispose();
    });
  }

  it("decorative={false} opts an xs fan back into a status region", () => {
    const { target, dispose } = mountIn(PaintLoader, { size: "xs", decorative: false, label: "Fixing" });
    const root = target.querySelector(".pinta-paint-loader")!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-label")).toBe("Fixing");
    expect(root.getAttribute("aria-hidden")).toBeNull();
    dispose();
  });

  it("small rings get a thicker stroke so the segments stay readable", () => {
    const widths = SIZES.map((size) => {
      const { target, dispose } = mountIn(PaintLoader, { size });
      const w = Number(target.querySelector("svg circle.seg")!.getAttribute("stroke-width"));
      dispose();
      return w;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
  });

  it('tone="mono" paints every swatch in currentColor at stepped opacity (F2)', () => {
    const { target, dispose } = mountIn(PaintLoader, { size: "xs", tone: "mono" });
    const root = target.querySelector(".pinta-paint-loader")!;
    expect(root.getAttribute("data-tone")).toBe("mono");
    const segs = [...target.querySelectorAll("svg circle.seg")];
    expect(segs.length).toBe(5);
    for (const c of segs) expect(c.getAttribute("stroke")).toBe("currentColor");
    dispose();
    const five = mountIn(PaintLoader, { size: "lg", tone: "mono" });
    const ops = [...five.target.querySelectorAll("svg circle.seg")].map((r) => Number(r.getAttribute("stroke-opacity")));
    expect(ops.length).toBe(5);
    for (let i = 1; i < ops.length; i++) expect(ops[i]).toBeGreaterThan(ops[i - 1]);
    expect(ops[ops.length - 1]).toBe(1);
    // Paint tone never sets opacity — the hex palette carries the contrast.
    const paint = mountIn(PaintLoader, { size: "lg" });
    for (const r of paint.target.querySelectorAll("svg circle.seg")) expect(r.getAttribute("stroke-opacity")).toBeNull();
    five.dispose(); paint.dispose();
  });

  it("every size renders a 5-paint ring — one segment per paint, evenly spaced", () => {
    for (const size of SIZES) {
      const { target, dispose } = mountIn(PaintLoader, { size });
      const segs = [...target.querySelectorAll("svg circle.seg")];
      expect(segs.length, `segment count at ${size}`).toBe(5);
      expect(segs.map((c) => c.getAttribute("stroke"))).toEqual(["#C2378F", "#F2456E", "#FF6B3D", "#FF9A2B", "#FFC93C"]);
      const offsets = segs.map((c) => Number(c.getAttribute("stroke-dashoffset")));
      const step = offsets[0] - offsets[1];
      expect(step).toBeGreaterThan(0);
      for (let i = 1; i < offsets.length; i++) expect(offsets[i - 1] - offsets[i]).toBeCloseTo(step, 5);
      dispose();
    }
  });

  it("custom label + title are forwarded (on a status-sized fan)", () => {
    const { target, dispose } = mountIn(PaintLoader, { size: "md", label: "Filing issues", title: "Filing…" });
    const root = target.querySelector(".pinta-paint-loader")!;
    expect(root.getAttribute("aria-label")).toBe("Filing issues");
    expect(root.getAttribute("title")).toBe("Filing…");
    dispose();
  });

  it("decorative drops role/aria-label and hides from AT", () => {
    const { target, dispose } = mountIn(PaintLoader, { size: "lg", decorative: true, label: "ignored" });
    const root = target.querySelector(".pinta-paint-loader")!;
    expect(root.getAttribute("role")).toBeNull();
    expect(root.getAttribute("aria-label")).toBeNull();
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelector('[role="status"]')).toBeNull();
    dispose();
  });

  it("class passthrough lands on the root alongside the base classes", () => {
    const { target, dispose } = mountIn(PaintLoader, { class: "drop-shadow-sm my-extra" });
    const root = target.querySelector(".pinta-paint-loader")!;
    expect(root.classList.contains("drop-shadow-sm")).toBe(true);
    expect(root.classList.contains("my-extra")).toBe(true);
    expect(root.classList.contains("inline-flex")).toBe(true);
    expect(root.classList.contains("shrink-0")).toBe(true);
    dispose();
  });

  it("default size is sm and never uses the legacy animate-spin class", () => {
    const { target, dispose } = mountIn(PaintLoader, {});
    expect(target.querySelector(".pinta-paint-loader")!.getAttribute("data-size")).toBe("sm");
    expect(target.querySelector(".animate-spin")).toBeNull();
    dispose();
  });
});

describe("EmptyState", () => {
  it("renders title + hint + default fan icon chip (aria-hidden)", () => {
    const { target, dispose } = mountIn(EmptyState, { title: "Start annotating", hint: "Hover the page" });
    const root = target.querySelector(".pinta-empty-state")!;
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-compact")).toBeNull();
    expect(root.className).toContain("py-12");
    expect(root.textContent).toContain("Start annotating");
    expect(root.textContent).toContain("Hover the page");
    const chip = root.querySelector('[aria-hidden="true"].rounded-full')!;
    expect(chip, "icon chip").toBeTruthy();
    expect(chip.className).toContain("w-14");
    expect(chip.querySelectorAll("svg rect").length, "default 3-swatch static fan").toBe(3);
    // No live region on an empty state — nothing is loading.
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(target.querySelector(".animate-spin")).toBeNull();
    dispose();
  });

  it("heading prop renders the title as h2 / h3 (default p) — F5", () => {
    for (const heading of ["h2", "h3", "p"] as const) {
      const { target, dispose } = mountIn(EmptyState, { title: "Devices", heading });
      const root = target.querySelector(".pinta-empty-state")!;
      const el = root.querySelector("h2, h3, p")!;
      expect(el.tagName.toLowerCase(), `heading=${heading}`).toBe(heading);
      expect(el.textContent).toBe("Devices");
      expect(el.className).toContain("font-semibold");
      dispose();
    }
    const d = mountIn(EmptyState, { title: "T" });
    expect(d.target.querySelector(".pinta-empty-state h2, .pinta-empty-state h3")).toBeNull();
    d.dispose();
  });

  it("compact variant tightens padding + chip + title size", () => {
    const { target, dispose } = mountIn(EmptyState, { title: "No sessions yet", compact: true });
    const root = target.querySelector(".pinta-empty-state")!;
    expect(root.getAttribute("data-compact")).toBe("true");
    expect(root.className).toContain("py-7");
    expect(root.querySelector(".rounded-full")!.className).toContain("w-10");
    expect(root.querySelector("p")!.className).toContain("text-[13px]");
    dispose();
  });

  it("renders custom icon, action and children snippets; richHint replaces hint", () => {
    const { target, dispose } = mountIn(EmptyState, {
      title: "T",
      icon: snippet('<i data-t="icon">I</i>'),
      action: snippet('<button data-t="cta">Generate</button>'),
      children: snippet('<div data-t="body">body</div>'),
      richHint: snippet('<span data-t="rich">rich <code>hint</code></span>'),
    });
    const root = target.querySelector(".pinta-empty-state")!;
    expect(root.querySelector('[data-t="icon"]')).toBeTruthy();
    expect(root.querySelectorAll("svg rect").length, "default fan replaced by custom icon").toBe(0);
    expect(root.querySelector('[data-t="cta"]')).toBeTruthy();
    expect(root.querySelector('[data-t="body"]')).toBeTruthy();
    expect(root.querySelector('[data-t="rich"]')).toBeTruthy();
    // Order: chip → text → children → action.
    const order = [...root.children].map((c) => c.className.split(" ")[0] ?? "");
    expect(root.children.length).toBe(4);
    expect(root.lastElementChild!.querySelector('[data-t="cta"]')).toBeTruthy();
    expect(order[0]).toBe("rounded-full");
    dispose();
  });

  it("hint wins over richHint when both are given; class passthrough", () => {
    const { target, dispose } = mountIn(EmptyState, {
      title: "T", hint: "plain", richHint: snippet('<b data-t="rich">rich</b>'), class: "!py-6",
    });
    const root = target.querySelector(".pinta-empty-state")!;
    expect(root.textContent).toContain("plain");
    expect(root.querySelector('[data-t="rich"]')).toBeNull();
    expect(root.classList.contains("!py-6")).toBe(true);
    dispose();
  });
});

describe("LoadingState", () => {
  it("root is a polite status live region containing exactly one decorative lg PaintLoader", () => {
    const { target, dispose } = mountIn(LoadingState, { title: "Generating report…", hint: "Gathering…" });
    const root = target.querySelector(".pinta-loading-state")!;
    expect(root).toBeTruthy();
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.textContent).toContain("Generating report…");
    expect(root.textContent).toContain("Gathering…");
    const fans = root.querySelectorAll(".pinta-paint-loader");
    expect(fans.length).toBe(1);
    expect(fans[0].getAttribute("data-size")).toBe("lg");
    expect(fans[0].querySelectorAll("circle.seg").length).toBe(5);
    // One announcement per wait: the inner fan must not be a second status.
    expect(root.querySelectorAll('[role="status"]').length).toBe(0);
    expect(fans[0].getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelector(".animate-spin")).toBeNull();
    dispose();
  });

  it("compact uses the md fan + tighter padding; action + richHint render", () => {
    const { target, dispose } = mountIn(LoadingState, {
      title: "Parsing spec.md…", compact: true,
      richHint: snippet('<span data-t="rich">needs <code>/pinta</code></span>'),
      action: snippet('<button data-t="cancel">Cancel</button>'),
    });
    const root = target.querySelector(".pinta-loading-state")!;
    expect(root.getAttribute("data-compact")).toBe("true");
    expect(root.className).toContain("py-6");
    expect(root.querySelector(".pinta-paint-loader")!.getAttribute("data-size")).toBe("md");
    expect(root.querySelector('[data-t="rich"]')).toBeTruthy();
    expect(root.querySelector('[data-t="cancel"]')).toBeTruthy();
    dispose();
  });

  it("heading prop renders the title as h2 (default p) — F5", () => {
    const h = mountIn(LoadingState, { title: "Running Board…", heading: "h2" });
    const el = h.target.querySelector(".pinta-loading-state h2")!;
    expect(el, "h2 title").toBeTruthy();
    expect(el.textContent).toBe("Running Board…");
    h.dispose();
    const p = mountIn(LoadingState, { title: "T" });
    expect(p.target.querySelector(".pinta-loading-state h2, .pinta-loading-state h3")).toBeNull();
    p.dispose();
  });

  it("class passthrough lands on the root", () => {
    const { target, dispose } = mountIn(LoadingState, { title: "T", class: "my-extra" });
    expect(target.querySelector(".pinta-loading-state")!.classList.contains("my-extra")).toBe(true);
    dispose();
  });
});
