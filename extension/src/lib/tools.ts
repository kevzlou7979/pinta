// Single source of truth for Pinta's annotation tools — id, label, icon,
// single-key shortcut, and whether it's a "draw" tool (arrow/rect/pen/pin
// enter draw mode with that specific tool; the rest map to their own mode).
// Shared by the side-panel TOOL grid and the on-page floating toolbar so the
// two never drift.

export type Tool =
  | "select"
  | "arrow"
  | "rect"
  | "circle"
  | "freehand"
  | "pin"
  | "image"
  | "move"
  | "text"
  | "delete"
  | "resize"
  | "paint"
  | "scale"
  | "transform";

export type ToolDef = {
  id: Tool;
  label: string;
  /** Inner SVG markup for a 24×24 stroke icon (fill/stroke = currentColor). */
  svg: string;
  /** Single-key shortcut (no modifier). Shown in tooltips; handled only while
   *  the floating toolbar is enabled and the user isn't typing in a field. */
  key: string;
  /** True for tools that enter "draw" mode carrying this tool id. */
  draw?: boolean;
};

export const TOOLS: ToolDef[] = [
  {
    id: "select",
    label: "Select",
    key: "V",
    svg: '<path d="M4 4l7 17 2.5-7.5L21 11z" fill="currentColor" stroke="currentColor" stroke-width="1"/>',
  },
  {
    id: "arrow",
    label: "Arrow",
    key: "A",
    draw: true,
    svg: '<path d="M7 17 L17 7"/><path d="M9 7 L17 7 L17 15"/>',
  },
  {
    id: "rect",
    label: "Rect",
    key: "R",
    draw: true,
    svg: '<rect x="3" y="6" width="18" height="12" rx="1.5"/>',
  },
  {
    id: "circle",
    label: "Circle",
    key: "O",
    draw: true,
    svg: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  },
  {
    id: "freehand",
    label: "Pen",
    key: "P",
    draw: true,
    svg: '<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  },
  {
    id: "pin",
    label: "Pin",
    key: "N",
    draw: true,
    svg: '<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="3"/>',
  },
  {
    id: "image",
    label: "Image",
    key: "I",
    svg: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="m3 16 5-5c.928-.893 2.072-.893 3 0l5 5"/><path d="m14 14 1-1c.928-.893 2.072-.893 3 0l3 3"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><path d="M19 3v4"/><path d="M17 5h4"/>',
  },
  {
    id: "move",
    label: "Move",
    key: "M",
    svg: '<path d="M12 2v20"/><path d="M2 12h20"/><path d="m9 5 3-3 3 3"/><path d="m9 19 3 3 3-3"/><path d="m5 9-3 3 3 3"/><path d="m19 9 3 3-3 3"/>',
  },
  {
    id: "text",
    label: "Text",
    key: "T",
    svg: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  },
  {
    id: "delete",
    label: "Delete",
    key: "D",
    svg: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  },
  {
    id: "resize",
    label: "Resize",
    key: "S",
    svg: '<path d="M21 3 9 15"/><path d="M12 3H3v18h18v-9"/><path d="M16 3h5v5"/><path d="M14 15H9v-5"/>',
  },
  {
    id: "paint",
    label: "Paint",
    key: "B",
    svg: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  },
  {
    id: "scale",
    label: "Scale",
    key: "C",
    svg: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  },
  {
    id: "transform",
    label: "Free transform",
    key: "F",
    svg: '<path d="M4 8V4h4"/><path d="M20 8V4h-4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  },
];

/** Visual grouping in the toolbars: "annotate" = draw/point tools,
 *  "transform" = direct element edits. Rendered with a divider between groups. */
export const TOOL_GROUP: Record<Tool, "annotate" | "transform"> = {
  select: "annotate",
  arrow: "annotate",
  rect: "annotate",
  circle: "annotate",
  freehand: "annotate",
  pin: "annotate",
  image: "annotate",
  move: "transform",
  text: "transform",
  delete: "transform",
  resize: "transform",
  paint: "transform",
  scale: "transform",
  transform: "transform",
};

/** True when TOOLS[i] starts a new group vs TOOLS[i-1] (→ draw a divider). */
export function startsNewGroup(i: number): boolean {
  return i > 0 && TOOL_GROUP[TOOLS[i]!.id] !== TOOL_GROUP[TOOLS[i - 1]!.id];
}

/**
 * Toolbar slots — the draw shapes (arrow/rect/circle/pen/pin) collapse
 * into ONE expandable slot (Photoshop-style flyout); every other tool is
 * its own slot. Shared by the side-panel row and the floating palette so
 * the two never drift.
 */
export type ToolSlot =
  | { kind: "tool"; def: ToolDef }
  | { kind: "draw-group"; shapes: ToolDef[] };

export const DRAW_SHAPES: ToolDef[] = TOOLS.filter((t) => t.draw);

export const TOOL_SLOTS: ToolSlot[] = (() => {
  const slots: ToolSlot[] = [];
  let grouped = false;
  for (const t of TOOLS) {
    if (t.draw) {
      if (!grouped) {
        slots.push({ kind: "draw-group", shapes: DRAW_SHAPES });
        grouped = true;
      }
      continue;
    }
    slots.push({ kind: "tool", def: t });
  }
  return slots;
})();

/** Group of a slot (draw-group is always "annotate"). */
export function slotGroup(s: ToolSlot): "annotate" | "transform" {
  return s.kind === "draw-group" ? "annotate" : TOOL_GROUP[s.def.id];
}

/** True when TOOL_SLOTS[i] starts a new group vs its predecessor. */
export function slotStartsNewGroup(i: number): boolean {
  return (
    i > 0 && slotGroup(TOOL_SLOTS[i]!) !== slotGroup(TOOL_SLOTS[i - 1]!)
  );
}

/** Non-draw tools each map to their own overlay Mode; draw tools map to the
 *  shared "draw" mode carrying the tool id. */
export function toolMode(t: Tool): { mode: string; tool?: Tool } {
  const def = TOOLS.find((d) => d.id === t);
  return def?.draw ? { mode: "draw", tool: t } : { mode: t };
}

/** Look up a tool by its single-key shortcut (case-insensitive). */
export function toolForKey(key: string): ToolDef | undefined {
  const k = key.toUpperCase();
  return TOOLS.find((d) => d.key === k);
}
