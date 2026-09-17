import { describe, expect, it } from "vitest";
import {
  devicesCanvasTargetUrl,
  frameCaptureGeometry,
  isDevicesCanvasUrl,
  NEVER_RELAYABLE_FRAME_MESSAGES,
  RELAYABLE_FRAME_MESSAGES,
} from "./devices-frame.js";
import * as devices from "./devices.js";

describe("devices.ts compatibility re-exports", () => {
  it("re-exports the frame helpers", () => {
    expect(devices.frameCaptureGeometry).toBe(frameCaptureGeometry);
    expect(devices.isDevicesCanvasUrl).toBe(isDevicesCanvasUrl);
    expect(devices.devicesCanvasTargetUrl).toBe(devicesCanvasTargetUrl);
  });
});

describe("devices canvas URL helpers", () => {
  const ext = "chrome-extension://abcdefghijklmnop/";
  it("recognizes the canvas page and reads its target app URL", () => {
    const url = `${ext}src/devices/index.html?url=${encodeURIComponent("localhost:7878/course/1")}`;
    expect(isDevicesCanvasUrl(url, ext)).toBe(true);
    expect(isDevicesCanvasUrl(url, "chrome-extension://abcdefghijklmnop")).toBe(true);
    expect(devicesCanvasTargetUrl(url)).toBe("http://localhost:7878/course/1");
  });
  it("rejects other pages and unusable targets", () => {
    expect(isDevicesCanvasUrl(`${ext}src/sidepanel/index.html`, ext)).toBe(false);
    expect(isDevicesCanvasUrl("http://localhost:5173/src/devices/index.html", ext)).toBe(false);
    expect(isDevicesCanvasUrl("", ext)).toBe(false);
    expect(devicesCanvasTargetUrl(`${ext}src/devices/index.html`)).toBe("");
    expect(devicesCanvasTargetUrl(`${ext}src/devices/index.html?url=javascript:alert(1)`)).toBe("");
    expect(devicesCanvasTargetUrl("not a url")).toBe("");
  });
});

describe("frameCaptureGeometry", () => {
  const base = { cssWidth: 402, cssHeight: 874, viewportWidth: 1600, viewportHeight: 1000, devicePixelRatio: 2 };

  it("crops a fully visible scaled frame into a device-sized output", () => {
    const g = frameCaptureGeometry({ ...base, rect: { x: 100, y: 50, width: 201, height: 437 } })!;
    expect(g.scale).toBe(0.5);
    expect([g.sx, g.sy, g.sw, g.sh]).toEqual([200, 100, 402, 874]);
    expect([g.dx, g.dy, g.dw, g.dh]).toEqual([0, 0, 402, 874]);
    expect([g.outWidth, g.outHeight]).toEqual([402, 874]);
    expect(g.clipped).toBe(false);
  });

  it("places a frame clipped at the bottom of the window at its true offset", () => {
    const g = frameCaptureGeometry({ ...base, devicePixelRatio: 1, rect: { x: 10, y: 600, width: 402, height: 874 } })!;
    expect(g.scale).toBe(1);
    expect([g.sy, g.sh]).toEqual([600, 400]);
    expect([g.dy, g.dh]).toEqual([0, 400]);
    expect(g.clipped).toBe(true);
  });

  it("places a frame scrolled off the top at its true offset", () => {
    const g = frameCaptureGeometry({ ...base, devicePixelRatio: 1, rect: { x: 10, y: -200, width: 402, height: 874 } })!;
    expect([g.sy, g.sh]).toEqual([0, 674]);
    expect([g.dy, g.dh]).toEqual([200, 674]);
  });

  it("returns null when the frame is off-screen or unmeasured", () => {
    expect(frameCaptureGeometry({ ...base, rect: { x: 2000, y: 0, width: 402, height: 874 } })).toBeNull();
    expect(frameCaptureGeometry({ ...base, cssWidth: 0, rect: { x: 0, y: 0, width: 402, height: 874 } })).toBeNull();
  });
});

describe("canvas relay allowlist", () => {
  // The Devices canvas relay is a page -> extension hop: a framed page's
  // MAIN world shares the contentWindow identity AND the origin of the
  // overlay's isolated world, so no source/origin check can tell them
  // apart. Keeping side-effectful messages off this path is the defence,
  // so the allowlist is a security boundary, not a convenience list.
  it("never carries a message that reaches the agent", () => {
    for (const type of NEVER_RELAYABLE_FRAME_MESSAGES) {
      expect(RELAYABLE_FRAME_MESSAGES.has(type)).toBe(false);
    }
  });

  it("carries the UI-state messages the panel needs from a device frame", () => {
    for (const type of ["overlay.ready", "mode.changed", "frame.inactive"]) {
      expect(RELAYABLE_FRAME_MESSAGES.has(type)).toBe(true);
    }
  });

  it("is closed — an unknown message type is refused by default", () => {
    expect(RELAYABLE_FRAME_MESSAGES.has("session.submit")).toBe(false);
    expect(RELAYABLE_FRAME_MESSAGES.has("")).toBe(false);
  });
});
