// Insertion-point resolution for the Move (drag & drop) and Text
// (add-paragraph) tools. Given a viewport point, work out WHERE in the
// DOM the user means: which container, next to which sibling, before or
// after. The geometry heuristics (`flowAxis`, `pickInsertion`) are pure
// so they can be unit-tested without a DOM; `resolveInsertionPoint` is
// the thin DOM-facing wrapper the overlay calls per pointermove.

export type InsertionPosition = "before" | "after" | "inside";

export type Rect = { x: number; y: number; width: number; height: number };

export type ResolvedDrop = {
  /** The container the drop targets. */
  container: Element;
  /** Sibling anchor inside the container, null when it has no usable
   *  children (→ position "inside", i.e. append). */
  reference: Element | null;
  position: InsertionPosition;
  /** Viewport rect of the container — drives the highlight box. */
  containerRect: Rect;
  /** Viewport rect of the thin insertion indicator bar. */
  barRect: Rect;
};

/** Guess the flow axis of a child list from its geometry: if the
 *  children's centers spread more vertically than horizontally the list
 *  flows top-to-bottom ("y"), else left-to-right ("x"). A single child
 *  defaults to "y" (block flow is the common case). Pure. */
export function flowAxis(children: Rect[]): "x" | "y" {
  if (children.length < 2) return "y";
  let spreadX = 0;
  let spreadY = 0;
  for (let i = 1; i < children.length; i++) {
    const a = children[i - 1]!;
    const b = children[i]!;
    spreadX += Math.abs(b.x + b.width / 2 - (a.x + a.width / 2));
    spreadY += Math.abs(b.y + b.height / 2 - (a.y + a.height / 2));
  }
  return spreadX > spreadY ? "x" : "y";
}

/** Clamped distance from a point to a rect (0 when inside). Pure. */
function rectDistance(r: Rect, px: number, py: number): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * Pick the insertion slot among `children` for a pointer at (px,py):
 * the nearest child, and whether the pointer sits before or after its
 * center along the list's flow axis (the Test Pilot midpoint idiom).
 * Returns null for an empty list. Pure.
 */
export function pickInsertion(
  children: Rect[],
  px: number,
  py: number,
): { index: number; before: boolean; axis: "x" | "y" } | null {
  if (children.length === 0) return null;
  const axis = flowAxis(children);
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < children.length; i++) {
    const d = rectDistance(children[i]!, px, py);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  const r = children[index]!;
  const before =
    axis === "y" ? py < r.y + r.height / 2 : px < r.x + r.width / 2;
  return { index, before, axis };
}

/** The thin indicator bar for a slot: a horizontal line above/below the
 *  reference child in vertical flow, vertical line left/right of it in
 *  horizontal flow. Pure. */
export function insertionBarRect(
  child: Rect,
  before: boolean,
  axis: "x" | "y",
): Rect {
  const THICKNESS = 3;
  if (axis === "y") {
    const y = before ? child.y : child.y + child.height;
    return { x: child.x, y: y - THICKNESS / 2, width: child.width, height: THICKNESS };
  }
  const x = before ? child.x : child.x + child.width;
  return { x: x - THICKNESS / 2, y: child.y, width: THICKNESS, height: child.height };
}

const OVERLAY_HOST_TAG = "PINTA-OVERLAY-HOST";

function toRect(r: DOMRect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Children of a container that participate in the drop geometry:
 *  rendered elements, excluding the dragged element and Pinta's host. */
function usableChildren(container: Element, exclude: Element | null): Element[] {
  return [...container.children].filter((c) => {
    if (c === exclude) return false;
    if (c.tagName === OVERLAY_HOST_TAG) return false;
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/**
 * Resolve the insertion point under a viewport coordinate. `exclude` is
 * the element being dragged (skipped in hit-testing along with its
 * subtree — it also has pointer-events:none during a drag, but
 * `elementsFromPoint` is used so this stays correct regardless).
 * Returns null when the point hits nothing usable (bare html/body with
 * no rendered children — the "free position" case).
 */
export function resolveInsertionPoint(
  clientX: number,
  clientY: number,
  exclude: Element | null,
): ResolvedDrop | null {
  const stack = document.elementsFromPoint(clientX, clientY);
  const hit = stack.find((el) => {
    if (el.tagName === OVERLAY_HOST_TAG) return false;
    if (exclude && (el === exclude || exclude.contains(el))) return false;
    if (el === document.documentElement) return false;
    return true;
  });
  if (!hit) return null;

  // `elementsFromPoint` returns the deepest element: hitting a LEAF
  // targets its parent (with the leaf as the natural sibling anchor);
  // hitting an element that has rendered children means the pointer is
  // in that container's own padding/gap area — target it directly.
  const hitChildren = usableChildren(hit, exclude);
  const container: Element =
    hitChildren.length > 0 ? hit : hit.parentElement ?? hit;
  if (container === document.documentElement) return null;
  if (container.tagName === "BODY" && usableChildren(container, exclude).length === 0) {
    return null;
  }

  const children = usableChildren(container, exclude);
  const containerRect = toRect(container.getBoundingClientRect());
  if (children.length === 0) {
    // Empty container — append inside; bar hugs the inner top.
    return {
      container,
      reference: null,
      position: "inside",
      containerRect,
      barRect: { x: containerRect.x + 4, y: containerRect.y + 4, width: Math.max(containerRect.width - 8, 8), height: 3 },
    };
  }

  const picked = pickInsertion(
    children.map((c) => toRect(c.getBoundingClientRect())),
    clientX,
    clientY,
  )!;
  const reference = children[picked.index]!;
  return {
    container,
    reference,
    position: picked.before ? "before" : "after",
    containerRect,
    barRect: insertionBarRect(
      toRect(reference.getBoundingClientRect()),
      picked.before,
      picked.axis,
    ),
  };
}

/**
 * Auto-detect what the drop MEANS (the rule locked in the plan):
 * - "reorder" when a container was resolved AND the slot differs from
 *   where the element already sits (different parent, or a different
 *   position among its siblings).
 * - "free" when nothing usable was under the drop point, or the drop
 *   lands back in the element's own slot (the user moved it visually
 *   but not structurally → record the pixel offset instead).
 */
export function detectDropKind(
  resolved: ResolvedDrop | null,
  source: Element,
): "reorder" | "free" {
  if (!resolved) return "free";
  if (resolved.container !== source.parentElement) return "reorder";
  if (resolved.position === "inside") return "reorder";
  const ref = resolved.reference;
  if (!ref || ref === source) return "free";
  // Same container: does the slot equal the source's current position?
  // Inserting before the sibling that FOLLOWS source, or after the one
  // that PRECEDES it, is a no-op slot.
  const siblings = usableChildren(resolved.container, null);
  const si = siblings.indexOf(source);
  const ri = siblings.indexOf(ref);
  if (si === -1 || ri === -1) return "reorder";
  const slot = resolved.position === "before" ? ri : ri + 1;
  const ownSlot = si; // removing source shifts later slots by 1
  const normalized = slot > si ? slot - 1 : slot;
  return normalized === ownSlot ? "free" : "reorder";
}
