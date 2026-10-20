import { describe, expect, it } from "vitest";
import { downloadFor, DOWNLOAD_RELEASES } from "./download";
import { route } from "./route";
import worker from "./index";

const SLACKBOT_UA = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";

describe("download: one address for the newest Mac app", () => {
  it("sends /download/mac to the Apple silicon dmg of the latest release", () => {
    expect(downloadFor("/download/mac")).toBe(`${DOWNLOAD_RELEASES}/Context-mac-arm64.dmg`);
    expect(downloadFor("/download/mac/")).toBe(`${DOWNLOAD_RELEASES}/Context-mac-arm64.dmg`);
  });

  it("sends /download/mac/intel to the x64 dmg", () => {
    expect(downloadFor("/download/mac/intel")).toBe(`${DOWNLOAD_RELEASES}/Context-mac-x64.dmg`);
  });

  it("names no version, so a new release needs no change here", () => {
    for (const path of ["/download/mac", "/download/mac/intel"]) {
      const target = downloadFor(path) ?? "";
      expect(target.startsWith("https://github.com/Supa-Media/context/releases/latest/download/")).toBe(true);
      expect(target).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it.each(["/download", "/download/windows", "/download/mac/x", "/Download/mac", "/download/macx", "/download/constructor", "/download/__proto__"])(
    "%s is not a download",
    (path) => {
      expect(downloadFor(path)).toBeNull();
    },
  );

  it("routes ahead of the crawler check, so an unfurler is sent to the file too", () => {
    expect(route(new URL("https://context.lc/download/mac"), SLACKBOT_UA)).toEqual({
      kind: "download",
      location: `${DOWNLOAD_RELEASES}/Context-mac-arm64.dmg`,
    });
  });

  it("answers with a 302 nobody caches, never a remembered 301", async () => {
    const res = await worker.fetch(new Request("https://context.lc/download/mac"), {} as never, {
      waitUntil() {},
      passThroughOnException() {},
    } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${DOWNLOAD_RELEASES}/Context-mac-arm64.dmg`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
