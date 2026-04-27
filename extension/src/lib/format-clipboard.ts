import type { Annotation } from "@pinta/shared";

/**
 * Formats a session's annotations as a single markdown blob suitable for
 * pasting into claude.ai web, ChatGPT, another Claude Code chat, or any
 * agent that doesn't speak Pinta's protocol.
 */
export function formatSessionAsClipboard(input: {
  url: string;
  annotations: Annotation[];
}): string {
  const { url, annotations } = input;
  const lines: string[] = [];

  lines.push(`Pinta annotations on ${url}`);
  lines.push("");
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
