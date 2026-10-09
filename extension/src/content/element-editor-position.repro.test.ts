// Element editor popover placement: it must never be cut off by the
// viewport edge (auto-clamp on the measured box, layout viewport, resize),
// and the user can drag it by its header without dragging it off-screen.
//   npx vitest run --config vitest.repro.config.ts element-editor-position
import { describe, it, expect } from "vitest";
import { flushSync, mount, tick } from "svelte";
import ElementEditor from "./ElementEditor.svelte";
import { reactiveProps } from "./test-props.svelte.js";

const live = {
  color: "", backgroundColor: "", fontSize: "", fontWeight: "", fontFamily: "",
  width: "", height: "", padding: "", margin: "", borderRadius: "", display: "", lineHeight: "", boxShadow: "",
  ownFontSize: 16, parentFontSize: 16, rootFontSize: 16, parentWidth: 800,
} as any;

async function mountAt(anchor: { top: number; left: number; width: number; height: number }, title = "a.app-button") {
  document.body.innerHTML = "";
  const target = document.createElement("div");
  document.body.appendChild(target);
  const props = reactiveProps<any>({
    anchor, title, liveText: "Continue", liveStyles: live, comment: "", customCss: "",
    cssChanges: {}, contentAfter: "", images: [], onsubmit() {}, oncancel() {},
  });
  mount(ElementEditor, { target, props });
  flushSync(); await tick(); flushSync();
  const box = () => target.querySelector<HTMLElement>(".popup--editor")!;
  const pos = () => ({ left: parseFloat(box().style.left), top: parseFloat(box().style.top) });
  return { props, box, pos, target };
}

describe("ElementEditor placement", () => {
  it("clamps a popup anchored at the right edge fully inside the viewport", async () => {
    const vw = window.innerWidth;
    const { pos } = await mountAt({ top: 100, left: vw - 120, width: 110, height: 32 });
    // happy-dom has no layout, so the box falls back to 360 + 22 chrome.
    expect(pos().left + 382).toBeLessThanOrEqual(vw - 8);
    expect(pos().left).toBeGreaterThanOrEqual(8);
  });

  it("flips above when there is no room below, and never above the top edge", async () => {
    const vh = window.innerHeight;
    const { pos } = await mountAt({ top: vh - 40, left: 50, width: 100, height: 30 });
    expect(pos().top + 320).toBeLessThanOrEqual(vh - 8);
    expect(pos().top).toBeGreaterThanOrEqual(8);
  });

  it("drags by the header, stays inside the viewport, and resets for a new element", async () => {
    const { props, pos, box } = await mountAt({ top: 100, left: 100, width: 80, height: 30 });
    const head = box().querySelector<HTMLElement>(".popup__head")!;
    const start = pos();
    const ev = (type: string, x: number, y: number) =>
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 } as any);
    head.dispatchEvent(ev("pointerdown", 200, 110));
    flushSync();
    expect(box().classList.contains("popup--dragging")).toBe(true);
    head.dispatchEvent(ev("pointermove", 260, 150));
    flushSync();
    expect(pos()).toEqual({ left: start.left + 60, top: start.top + 40 });
    // Far past the right edge: pinned to the edge, not cut off.
    head.dispatchEvent(ev("pointermove", 99999, 150));
    flushSync();
    expect(pos().left + 382).toBeLessThanOrEqual(window.innerWidth - 8);
    head.dispatchEvent(ev("pointerup", 99999, 150));
    flushSync();
    expect(box().classList.contains("popup--dragging")).toBe(false);
    // Picking another element brings back the automatic spot.
    props.title = "button.save";
    props.anchor = { top: 100, left: 100, width: 80, height: 30 };
    flushSync(); await tick(); flushSync();
    expect(pos()).toEqual(start);
  });

  it("re-clamps when the window shrinks", async () => {
    const { pos } = await mountAt({ top: 100, left: 600, width: 80, height: 30 });
    (window as any).innerWidth = 700;
    window.dispatchEvent(new Event("resize"));
    flushSync(); await tick(); flushSync();
    expect(pos().left + 382).toBeLessThanOrEqual(700 - 8);
  });
});
