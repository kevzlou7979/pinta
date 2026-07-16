import type { Annotation } from "@pinta/shared";

/**
 * Human sentences for a structural annotation (move / text-insert /
 * delete), used by both export formats so an agent without the wire JSON
 * still gets BOTH ends of the change. Returns [] for annotations without
 * one.
 */
function structuredChangeLines(a: Annotation): string[] {
  const out: string[] = [];
  if (a.kind === "delete") {
    const targets = a.targets ?? (a.target ? [a.target] : []);
    const sels = targets
      .map((t) => `\`${t.selector}\``)
      .filter((s) => s !== "``")
      .join(", ");
    if (targets.length > 1) {
      out.push(`Remove these ${targets.length} elements from the source${sels ? `: ${sels}` : ""}.`);
    } else {
      out.push(`Remove this element from the source${sels ? ` (${sels})` : ""}.`);
    }
  }
  if (a.move) {
    if (a.move.drop === "reorder") {
      const ref = a.move.reference;
      const where = ref
        ? `${a.move.position ?? "before"} \`${ref.selector}\``
        : "appended inside";
      out.push(
        `Move this element into \`${a.move.container?.selector ?? "(container)"}\`, ${where}.`,
      );
      if (a.move.container?.sourceFile) {
        out.push(
          `Destination source: ${a.move.container.sourceFile}${a.move.container.sourceLine ? `:${a.move.container.sourceLine}` : ""}`,
        );
      }
    } else {
      out.push(
        `Move this element by ${a.move.offset?.dx ?? 0}px, ${a.move.offset?.dy ?? 0}px (free position — apply via CSS positioning).`,
      );
    }
  }
  if (a.textInsert) {
    const ref = a.textInsert.reference;
    const where = ref
      ? `${a.textInsert.position} \`${ref.selector}\``
      : "inside this container";
    out.push(`Add a new paragraph ${where}: "${a.textInsert.text}"`);
  }
  return out;
}

export type ExportFormat = "md" | "txt";

export type FormatOptions = {
  /** Filenames of accompanying screenshots the consumer should look at,
   *  one per scroll section. The markdown emits an image reference per
   *  filename so an agent picks them all up alongside the text context. */
  screenshotFilenames?: string[];
};

/**
 * Formats a session in the requested format. Markdown is the default
 * (suitable for paste into claude.ai web, ChatGPT, etc.); TXT is a
 * cleaner prose form for handing the file to an agent that's reading
 * it from disk and may not benefit from the markdown decoration.
 */
export function formatSession(
  input: { url: string; annotations: Annotation[] },
  format: ExportFormat = "md",
  opts: FormatOptions = {},
): string {
  return format === "txt"
    ? formatSessionAsText(input, opts)
    : formatSessionAsClipboard(input, opts);
}

/**
 * Formats a session's annotations as a single markdown blob suitable for
 * pasting into claude.ai web, ChatGPT, another Claude Code chat, or any
 * agent that doesn't speak Pinta's protocol.
 */
export function formatSessionAsClipboard(input: {
  url: string;
  annotations: Annotation[];
}, opts: FormatOptions = {}): string {
  const { url, annotations } = input;
  const lines: string[] = [];

  lines.push(`Pinta annotations on ${url}`);
  lines.push("");
  if (opts.screenshotFilenames?.length) {
    lines.push(
      `Each annotation below corresponds to a numbered badge in the screenshots.`,
    );
    if (opts.screenshotFilenames.length > 1) {
      lines.push(
        `Page is split into ${opts.screenshotFilenames.length} sections (one image per scroll position).`,
      );
    }
    lines.push("");
    opts.screenshotFilenames.forEach((name, i) => {
      const label = opts.screenshotFilenames!.length === 1
        ? "Screenshot"
        : `Section ${i + 1}`;
      lines.push(`![${label}](${name})`);
    });
    lines.push("");
  }
  lines.push(
    "Apply these UI changes to my project. For each, locate the source " +
      "file by the selector / nearby text, present a plan grouped by file, " +
      "and ask before editing.",
  );
  lines.push("");

  annotations.forEach((a, i) => {
    lines.push(`### ${i + 1}. ${a.kind === "select" ? "Element" : a.kind}`);
    if (a.target?.selector) {
      lines.push(`- **Selector:** \`${a.target.selector}\``);
    }
    if (a.target?.outerHTML) {
      const html = a.target.outerHTML.replace(/\s+/g, " ").trim().slice(0, 240);
      lines.push(`- **Outer HTML:** \`${html}\``);
    }
    if (a.target?.nearbyText?.length) {
      const txt = a.target.nearbyText[0]!.slice(0, 200);
      lines.push(`- **Nearby text:** "${txt}"`);
    }
    if (a.target?.sourceFile) {
      const src = a.target.sourceLine
        ? `${a.target.sourceFile}:${a.target.sourceLine}`
        : a.target.sourceFile;
      lines.push(`- **Source:** \`${src}\``);
    }
    for (const change of structuredChangeLines(a)) {
      lines.push(`- **Change:** ${change}`);
    }
    lines.push(`- **Comment:** ${a.comment}`);
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Plain-text variant — same content, no markdown decoration. Designed
 * for files that an agent reads from disk: less visual noise, cleaner
 * line structure, easier to grep.
 */
export function formatSessionAsText(input: {
  url: string;
  annotations: Annotation[];
}, opts: FormatOptions = {}): string {
  const { url, annotations } = input;
  const lines: string[] = [];

  lines.push(`Pinta annotations`);
  lines.push(`URL: ${url}`);
  lines.push(`Total: ${annotations.length}`);
  if (opts.screenshotFilenames?.length) {
    if (opts.screenshotFilenames.length === 1) {
      lines.push(`Screenshot: ${opts.screenshotFilenames[0]}`);
    } else {
      lines.push(`Screenshots (${opts.screenshotFilenames.length} sections):`);
      opts.screenshotFilenames.forEach((name) => lines.push(`  - ${name}`));
    }
  }
  lines.push("");
  lines.push(
    "Apply these UI changes to the project. For each annotation, locate the source",
  );
  lines.push(
    "file by selector / nearby text, present a plan grouped by file, and ask before",
  );
  lines.push("editing.");
  lines.push("");
  lines.push("---");
  lines.push("");

  annotations.forEach((a, i) => {
    lines.push(`Annotation ${i + 1} (${a.kind === "select" ? "element" : a.kind})`);
    if (a.target?.selector) lines.push(`  Selector: ${a.target.selector}`);
    if (a.target?.outerHTML) {
      const html = a.target.outerHTML.replace(/\s+/g, " ").trim().slice(0, 240);
      lines.push(`  Outer HTML: ${html}`);
    }
    if (a.target?.nearbyText?.length) {
      lines.push(`  Nearby text: "${a.target.nearbyText[0]!.slice(0, 200)}"`);
    }
    if (a.target?.sourceFile) {
      const src = a.target.sourceLine
        ? `${a.target.sourceFile}:${a.target.sourceLine}`
        : a.target.sourceFile;
      lines.push(`  Source: ${src}`);
    }
    for (const change of structuredChangeLines(a)) {
      lines.push(`  Change: ${change.replace(/`/g, "")}`);
    }
    lines.push(`  Comment: ${a.comment}`);
    lines.push("");
  });

  return lines.join("\n");
}
