/**
 * A cast scene's uploaded sounds (Dev2, 2026-09-29: "Built-in + uploads").
 *
 * They ride the pasted-image road: stored in the workspace's own bucket by an
 * editor, named from their bytes, read back only for a note that names them.
 * What is new, and what these tests hold, is that **the bytes decide**: a
 * declared `audio/*` type only asks, and a file whose first bytes are not an
 * MP3, WAV, Ogg or M4A is refused whatever it was called.
 */

import { describe, expect, test } from "vitest";
import {
  MAX_SCENE_SOUND_BYTES,
  SCENE_SOUND_LEAF,
  sceneSoundLeaf,
  sniffSoundType,
} from "@context/shared/src/sceneSounds";
import { api } from "../../_generated/api";
import { writeImage } from "../../functions/lib/fileOps";
import { assertWritableContentType } from "../../../mcp/src/store/index.js";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { memoryStore } from "../storeStub.helpers";
import { fixture, share, type Fixture } from "./fixtures.helpers";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

const WAV = bytes("RIFF", [36, 0, 0, 0], "WAVEfmt ", [16, 0, 0, 0, 1, 0, 1, 0]);
const OGG = bytes("OggS", [0, 2, 0, 0, 0, 0]);
const M4A = bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 0, 0]);
const MP3_ID3 = bytes("ID3", [4, 0, 0, 0, 0, 0, 0]);
const MP3_FRAME = bytes([0xff, 0xfb, 0x90, 0x64, 0, 0]);
const ADTS = bytes([0xff, 0xf1, 0x50, 0x80]);
const PNG = bytes([137, 80, 78, 71, 13, 10, 26, 10]);
const HTML = bytes("<html><script>alert(1)</script>");

describe("what a file is, by its bytes", () => {
  test("the four formats are known by their first bytes", () => {
    expect(sniffSoundType(WAV)).toBe("wav");
    expect(sniffSoundType(OGG)).toBe("ogg");
    expect(sniffSoundType(M4A)).toBe("m4a");
    expect(sniffSoundType(MP3_ID3)).toBe("mp3");
    expect(sniffSoundType(MP3_FRAME)).toBe("mp3");
  });

  test("everything else is nothing, whatever it is called", () => {
    for (const other of [PNG, HTML, ADTS, bytes("RIFF", [0, 0, 0, 0], "AVI "), bytes([0, 0, 0, 32], "ftypqt  "), new Uint8Array()]) {
      expect(sniffSoundType(other)).toBeNull();
    }
  });

  test("a sound's name is its hash and its format, nothing a caller chose", () => {
    expect(sceneSoundLeaf("0123456789ABCDEFffff", "wav")).toBe("sound-0123456789abcdef.wav");
    expect(SCENE_SOUND_LEAF.test("sound-0123456789abcdef.wav")).toBe(true);
    expect(SCENE_SOUND_LEAF.test("sound-0123456789abcdef.svg")).toBe(false);
    expect(() => sceneSoundLeaf("abc", "mp3")).toThrow();
  });
});

describe("the store keeps a sound only as what it is", () => {
  test("the four sound types are writable, and nothing else new is", () => {
    for (const type of ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]) {
      expect(assertWritableContentType(type)).toBe(type);
    }
    for (const type of ["audio/x-wav", "audio/webm", "video/mp4", "text/html"]) {
      expect(() => assertWritableContentType(type)).toThrow();
    }
  });

  test("a sound's bytes must be the format its name says", async () => {
    const store = memoryStore();
    await expect(writeImage(store, { leaf: "sound-0123456789abcdef.wav", bytes: WAV, contentType: "audio/wav" })).resolves.toMatchObject({
      key: ".context/assets/images/sound-0123456789abcdef.wav",
    });
    await expect(
      writeImage(store, { leaf: "sound-0123456789abcdef.mp3", bytes: WAV, contentType: "audio/mpeg" }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
    await expect(
      writeImage(store, { leaf: "sound-0123456789abcdef.ogg", bytes: HTML, contentType: "audio/ogg" }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
  });

  test("a sound is at most two megabytes", async () => {
    const big = new Uint8Array(MAX_SCENE_SOUND_BYTES + 1);
    big.set(OGG);
    await expect(
      writeImage(memoryStore(), { leaf: "sound-0123456789abcdef.ogg", bytes: big, contentType: "audio/ogg" }),
    ).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });
});

describe("uploading a scene's sound from the studio", () => {
  async function upload(f: Fixture, body: Uint8Array, contentType: string, who = f.owner) {
    return asUser(f.t, who).action(api.functions.files.storeNoteImage, {
      workspaceId: f.workspaceId,
      bytes: body.slice().buffer,
      contentType,
    });
  }

  async function rewrite(f: Fixture, path: string, text: string): Promise<void> {
    const existing = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path,
      text,
      expectedEtag: existing.etag,
    });
  }

  test("stored under the format its bytes say, not the one declared, and read back for the note that names it", async () => {
    const f = await fixture();
    // Declared as MP3, and it is a WAV: stored as a WAV.
    const { leaf } = await upload(f, WAV, "audio/mpeg");
    expect(leaf).toMatch(/^sound-[0-9a-f]{16}\.wav$/);
    await rewrite(f, "1-projects/shared.md", `---\nsounds: [comment ${leaf}]\n---\n# Shared\n`);
    const read = await asUser(f.t, f.owner).action(api.functions.files.readNoteImage, {
      workspaceId: f.workspaceId,
      notePath: "1-projects/shared.md",
      leaf,
    });
    expect(new Uint8Array(read.bytes)).toEqual(WAV);
    expect(read.contentType).toBe("audio/wav");
  });

  test("a file that is not a sound is refused, even when it says it is one", async () => {
    const f = await fixture();
    for (const body of [HTML, PNG, ADTS]) {
      const error = await captureError(() => upload(f, body, "audio/mpeg"));
      expect(errorCode(error)).toBe("PATH_INVALID");
    }
    expect([...f.backend.objects.keys()].some((key) => key.includes("sound-"))).toBe(false);
  });

  test("a member cannot upload, and cannot hear one only a private note names", async () => {
    const f = await fixture();
    await share(f);
    expect(errorCode(await captureError(() => upload(f, OGG, "audio/ogg", f.reader)))).toBe("INSUFFICIENT_ROLE");
    const { leaf } = await upload(f, OGG, "audio/ogg");
    await rewrite(f, "2-areas/private-note.md", `---\nsounds: [join ${leaf}]\n---\n# Private\n`);
    for (const notePath of ["2-areas/private-note.md", "1-projects/shared.md"]) {
      const error = await captureError(() =>
        asUser(f.t, f.reader).action(api.functions.files.readNoteImage, { workspaceId: f.workspaceId, notePath, leaf }),
      );
      expect(errorCode(error)).toBe("FILE_NOT_FOUND");
    }
  });
});
