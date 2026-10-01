import { describe, expect, test } from "@jest/globals";
import {
  EXPORT_SIZES,
  canExportVideo,
  cropFor,
  exportFileName,
  pickVideoType,
} from "../features/studio/export/videoExport";

/*
  "is there a way you can do an easy export so I dont have to screen record
  all the time" (Dev2, 2026-10-01): the studio records its own stage and saves
  a file at the frame's delivery size.
*/

describe("the export size", () => {
  test("each frame saves at the size it is delivered at", () => {
    expect(EXPORT_SIZES.phone).toEqual({ width: 1080, height: 1920 });
    expect(EXPORT_SIZES.desktop).toEqual({ width: 1920, height: 1080 });
    expect(EXPORT_SIZES.square).toEqual({ width: 1080, height: 1080 });
  });
});

describe("pickVideoType", () => {
  test("an MP4 when the browser can make one", () => {
    const type = pickVideoType((mime) => mime.startsWith("video/mp4"));
    expect(type?.extension).toBe("mp4");
    expect(type?.mimeType).toMatch(/^video\/mp4/);
  });

  test("H.264 with AAC before a bare MP4", () => {
    const type = pickVideoType(() => true);
    expect(type?.mimeType).toContain("avc1");
    expect(type?.mimeType).toContain("mp4a");
  });

  test("WebM when MP4 is out of reach", () => {
    const type = pickVideoType((mime) => mime.startsWith("video/webm"));
    expect(type?.extension).toBe("webm");
  });

  test("nothing it can record, nothing picked", () => {
    expect(pickVideoType(() => false)).toBeNull();
  });
});

describe("exportFileName", () => {
  test("the scene's name and the frame, in plain lower case", () => {
    expect(exportFileName("I told Claude!", "phone", "mp4")).toBe("i-told-claude-phone.mp4");
    expect(exportFileName("  Still waiting  to get paid ", "square", "webm")).toBe("still-waiting-to-get-paid-square.webm");
  });

  test("a name with nothing usable in it is still a file name", () => {
    expect(exportFileName("???", "desktop", "mp4")).toBe("scene-desktop.mp4");
    expect(exportFileName("../../etc", "phone", "mp4")).toBe("etc-phone.mp4");
  });
});

describe("cropFor", () => {
  test("the stage's box, in the captured video's own pixels", () => {
    // A 1000×800 window captured at twice its size.
    const crop = cropFor({ left: 100, top: 50, width: 300, height: 600 }, { width: 1000, height: 800 }, { width: 2000, height: 1600 });
    expect(crop).toEqual({ x: 200, y: 100, width: 600, height: 1200 });
  });

  test("kept inside the video when the box overhangs it", () => {
    const crop = cropFor({ left: -10, top: 700, width: 200, height: 200 }, { width: 1000, height: 800 }, { width: 1000, height: 800 });
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(700);
    expect(crop.y + crop.height).toBeLessThanOrEqual(800);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1000);
  });

  test("no video yet: nothing to draw", () => {
    expect(cropFor({ left: 0, top: 0, width: 10, height: 10 }, { width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("canExportVideo", () => {
  const chrome = {
    navigator: { mediaDevices: { getDisplayMedia: () => Promise.resolve() } },
    MediaRecorder: Object.assign(function () {}, { isTypeSupported: (mime: string) => mime.startsWith("video/mp4") }),
    CropTarget: function () {},
    HTMLCanvasElement: { prototype: { captureStream() {} } },
  };

  test("a browser that can share this tab and record it", () => {
    expect(canExportVideo(chrome)).toBe(true);
  });

  test("no tab sharing, no recorder, or no way to offer this tab: no export", () => {
    expect(canExportVideo({ ...chrome, navigator: { mediaDevices: {} } })).toBe(false);
    expect(canExportVideo({ ...chrome, MediaRecorder: undefined })).toBe(false);
    // Safari and Firefox share a screen or a window, never offering this tab.
    expect(canExportVideo({ ...chrome, CropTarget: undefined })).toBe(false);
    expect(canExportVideo({ ...chrome, MediaRecorder: Object.assign(function () {}, { isTypeSupported: () => false }) })).toBe(false);
    expect(canExportVideo(undefined)).toBe(false);
  });
});
