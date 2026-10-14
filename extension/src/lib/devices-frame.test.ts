import { describe, expect, it } from "vitest";
import {
  devicesCanvasTargetUrl,
  frameCaptureGeometry,
  isDevicesCanvasUrl,
  ANNOTATE_ACK_MESSAGE,
  deviceFrameReadyUrl,
  isDirectSubframeSender,
  isDeadFrameError,
  onDeviceShot,
  parseAnnotateAck,
  sameDeviceWidth,
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

  it("clips to the canvas scroll surface, never taking the toolbar above it", () => {
    // <main> starts at y=60 under the toolbar; the frame is scrolled up under it.
    const visible = { x: 0, y: 60, width: 1600, height: 940 };
    const g = frameCaptureGeometry({ ...base, devicePixelRatio: 1, visible, rect: { x: 10, y: 20, width: 402, height: 874 } })!;
    expect([g.sy, g.sh]).toEqual([60, 834]);
    expect([g.dy, g.dh]).toEqual([40, 834]);
    expect(g.clipped).toBe(true);
    // Fully inside the surface: not clipped.
    const inside = frameCaptureGeometry({ ...base, devicePixelRatio: 1, visible, rect: { x: 10, y: 80, width: 402, height: 874 } })!;
    expect(inside.clipped).toBe(false);
    // Entirely under the toolbar: nothing to capture.
    expect(frameCaptureGeometry({ ...base, visible, rect: { x: 10, y: -900, width: 402, height: 874 } })).toBeNull();
  });
});

describe("which device an annotation belongs to", () => {
  const url = "http://localhost:5173/";
  const shot = { width: 402, url };
  it("matches device widths within a pixel", () => {
    expect(sameDeviceWidth(402, 402)).toBe(true);
    expect(sameDeviceWidth(402, 403)).toBe(true);
    expect(sameDeviceWidth(402, 820)).toBe(false);
    expect(sameDeviceWidth(undefined, 402)).toBe(false);
    expect(sameDeviceWidth(Number.NaN, 402)).toBe(false);
  });

  it("paints only annotations made in the captured device, on the captured page", () => {
    const mobile = { viewport: { width: 402 }, url };
    const ipad = { viewport: { width: 820 }, url };
    const otherPage = { viewport: { width: 402 }, url: "http://localhost:5173/cart" };
    const noUrl = { viewport: { width: 402 } };
    const noViewport = { url };
    expect(onDeviceShot(mobile, shot, url)).toBe(true);
    expect(onDeviceShot(ipad, shot, url)).toBe(false);
    expect(onDeviceShot(otherPage, shot, url)).toBe(false);
    expect(onDeviceShot(noUrl, shot, url)).toBe(true); // session URL stands in
    expect(onDeviceShot(noUrl, shot, "http://localhost:5173/cart")).toBe(false);
    expect(onDeviceShot(noViewport, shot, url)).toBe(false); // text only
    // The frame couldn't say where it is: width alone decides.
    expect(onDeviceShot(otherPage, { width: 402, url: "" }, url)).toBe(true);
  });

  it("recognises a frame that is gone", () => {
    expect(isDeadFrameError(new Error("Could not establish connection. Receiving end does not exist."))).toBe(true);
    expect(isDeadFrameError(new Error("No frame with id 12 in tab 7."))).toBe(true);
    expect(isDeadFrameError(new Error("The message port closed before a response was received."))).toBe(false);
    expect(isDeadFrameError(undefined)).toBe(false);
  });
});

describe("device-frame messaging gates", () => {
  const ext = "abcdefghijklmnop";
  const direct = { id: ext, frameId: 3, url: "http://localhost:5173/a", tab: { id: 7 } };

  it("accepts only a direct sub-frame content-script sender of the canvas tab", () => {
    expect(isDirectSubframeSender(direct, ext, 7)).toBe(true);
    // relayed copy (no frameId), top frame, bad ids, other tab / extension
    expect(isDirectSubframeSender({ ...direct, frameId: undefined }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, frameId: 0 }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, frameId: -1 }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, frameId: 1.5 }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender(direct, ext, 8)).toBe(false);
    expect(isDirectSubframeSender(direct, ext, null)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, tab: null }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, id: "other" }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender(direct, "", 7)).toBe(false);
    expect(isDirectSubframeSender(null, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, id: undefined }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, frameId: "3" as unknown as number }, ext, 7)).toBe(false);
    expect(isDirectSubframeSender({ ...direct, tab: {} }, ext, 7)).toBe(false);
  });

  it("adopts an overlay.ready URL only when http(s) and on the frame's real origin", () => {
    const frame = "http://localhost:5173/course/1";
    expect(deviceFrameReadyUrl("http://localhost:5173/course/2#x", frame)).toBe("http://localhost:5173/course/2#x");
    expect(deviceFrameReadyUrl("https://evil.example/", frame)).toBe("");
    expect(deviceFrameReadyUrl("http://localhost:5174/", frame)).toBe("");
    expect(deviceFrameReadyUrl("javascript:alert(1)", frame)).toBe("");
    expect(deviceFrameReadyUrl("chrome-extension://abc/x.html", "chrome-extension://abc/y.html")).toBe("");
    expect(deviceFrameReadyUrl("http://localhost:5173/", "file:///C:/x.html")).toBe("");
    expect(deviceFrameReadyUrl("http://localhost:5173/", undefined)).toBe("");
    expect(deviceFrameReadyUrl(42, frame)).toBe("");
    expect(deviceFrameReadyUrl("http://", frame)).toBe("");
    // Userinfo / scheme tricks resolve to a different real origin.
    expect(deviceFrameReadyUrl("http://localhost:5173@evil.example/", frame)).toBe("");
    expect(deviceFrameReadyUrl("https://localhost:5173/", frame)).toBe("");
    expect(deviceFrameReadyUrl("data:text/html,http://localhost:5173/", frame)).toBe("");
    expect(deviceFrameReadyUrl(" http://localhost:5173/", frame)).toBe("");
    // A forged claim with no browser-reported sender url is refused.
    expect(deviceFrameReadyUrl("http://localhost:5173/", "")).toBe("");
  });

  it("parses only well-formed annotate acks", () => {
    // content/overlay.ts inlines this literal (keeps the chunk out of every page).
    expect(ANNOTATE_ACK_MESSAGE).toBe("devices.annotate-ack");
    expect(parseAnnotateAck({ type: ANNOTATE_ACK_MESSAGE, token: "f1", on: true })).toEqual({ token: "f1", on: true });
    expect(parseAnnotateAck({ type: ANNOTATE_ACK_MESSAGE, token: "f1", on: false })).toEqual({ token: "f1", on: false });
    expect(parseAnnotateAck({ type: "pinta-annotate-ack", token: "f1", on: true })).toBeNull();
    expect(parseAnnotateAck({ type: ANNOTATE_ACK_MESSAGE, token: "", on: true })).toBeNull();
    expect(parseAnnotateAck({ type: ANNOTATE_ACK_MESSAGE, token: "f1", on: "true" })).toBeNull();
    expect(parseAnnotateAck(null)).toBeNull();
  });
});
