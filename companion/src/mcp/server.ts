import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Backend } from "./backend.js";

// Injected by esbuild from companion/package.json — see build.mjs. The
// `typeof` guard keeps `tsx` (dev) runs from crashing when the macro
// hasn't been substituted; bundled builds always have it as a string.
declare const __PINTA_VERSION__: string;
const VERSION =
  typeof __PINTA_VERSION__ === "string" ? __PINTA_VERSION__ : "dev";

export function createMcpServer(backend: Backend): McpServer {
  const server = new McpServer({
    name: "pinta",
    version: VERSION,
  });

  server.registerTool(
    "get_pending_session",
    {
      description:
        "Long-poll for the next submitted annotation session from the Pinta " +
        "extension. Returns the session JSON when one is ready, or null on " +
        "timeout (re-call to keep polling). Use this once per /pinta workflow.",
    },
    async () => {
      const session = await backend.getPendingSession();
      return jsonResult(session);
    },
  );

  server.registerTool(
    "get_session",
    {
      description:
        "Fetch a specific session by id. Use this to re-read state after " +
        "a status update or to inspect a session you already started on.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const session = await backend.getSession(id);
      return jsonResult(session);
    },
  );

  server.registerTool(
    "mark_session_applying",
    {
      description:
        "Mark the session as applying (the Pinta side panel will show " +
        "'Agent is applying changes…'). Call this just before you start " +
        "editing files.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      await backend.setStatus(id, { status: "applying" });
      return ok(`session ${id} → applying`);
    },
  );

  server.registerTool(
    "mark_session_done",
    {
      description:
        "Mark the session as done with a one-line summary of what was " +
        "edited. Call this after edits land and tests/lint pass.",
      inputSchema: {
        id: z.string(),
        summary: z.string().describe("One-line summary of the changes made."),
      },
    },
    async ({ id, summary }) => {
      await backend.setStatus(id, { status: "done", summary });
      return ok(`session ${id} → done`);
    },
  );

  server.registerTool(
    "mark_session_error",
    {
      description:
        "Mark the session as failed with an error message. Use when you " +
        "could not locate source files, or edits were blocked.",
      inputSchema: {
        id: z.string(),
        errorMessage: z.string(),
      },
    },
    async ({ id, errorMessage }) => {
      await backend.setStatus(id, { status: "error", errorMessage });
      return ok(`session ${id} → error: ${errorMessage}`);
    },
  );

  server.registerTool(
    "mark_annotation_applying",
    {
      description:
        "Mark a single annotation as in-progress. Call this just before " +
        "you start editing the source file(s) for that annotation. The " +
        "side panel will show a spinner on the matching card.",
      inputSchema: {
        sessionId: z.string(),
        annotationId: z.string(),
      },
    },
    async ({ sessionId, annotationId }) => {
      await backend.setAnnotationStatus(sessionId, annotationId, {
        status: "applying",
      });
      return ok(`annotation ${annotationId} → applying`);
    },
  );

  server.registerTool(
    "mark_annotation_done",
    {
      description:
        "Mark a single annotation as completed. Call this once the edits " +
        "for that annotation have landed. The side panel will show a " +
        "checkmark on the matching card. When every annotation in a " +
        "session is done, the session itself auto-rolls to 'done'.",
      inputSchema: {
        sessionId: z.string(),
        annotationId: z.string(),
      },
    },
    async ({ sessionId, annotationId }) => {
      await backend.setAnnotationStatus(sessionId, annotationId, {
        status: "done",
      });
      return ok(`annotation ${annotationId} → done`);
    },
  );

  server.registerTool(
    "mark_annotation_error",
    {
      description:
        "Mark a single annotation as failed (couldn't locate the source, " +
        "edit blocked, etc.). Other annotations in the same session can " +
        "still complete normally.",
      inputSchema: {
        sessionId: z.string(),
        annotationId: z.string(),
        errorMessage: z.string(),
      },
    },
    async ({ sessionId, annotationId, errorMessage }) => {
      await backend.setAnnotationStatus(sessionId, annotationId, {
        status: "error",
        errorMessage,
      });
      return ok(`annotation ${annotationId} → error: ${errorMessage}`);
    },
  );

  server.registerTool(
    "get_screenshot",
    {
      description:
        "Fetch the full-page composited screenshot for a session as base64 " +
        "PNG. Annotations are baked into the image. The session payload " +
        "also contains a path on disk (`fullPageScreenshotPath`) which is " +
        "preferable when the agent has filesystem access.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await backend.getScreenshot(id);
      if (!result) {
        return ok("no screenshot available for that session");
      }
      return {
        content: [
          {
            type: "image",
            data: result.base64,
            mimeType: result.mediaType,
          },
        ],
      };
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: value === null ? "null" : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function ok(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}
