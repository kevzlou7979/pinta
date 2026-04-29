import type { Annotation } from "@pinta/shared";

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
    lines.push(`  Comment: ${a.comment}`);
    lines.push("");
  });

  return lines.join("\n");
}
