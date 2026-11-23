/**
 * Pictures reach the files bucket compressed, by both of the gateway's ways in
 * (`src/notes/pictureCompression.js`): a picture attached to `write_note`
 * (base64 or a URL) and one sent through an upload link.
 *
 * What has to hold: with the Images binding present, the stored object is the
 * encoder's WebP, its leaf says `.webp`, the note embeds that leaf, and it
 * reads back through `read_image`; the leaf is still named from the bytes that
 * came in, so the same picture sent twice is one object and an upload link's
 * sha256 still finds it. Without the binding nothing changes.
 *
 * Sabotage, each confirmed to fail a case here: store `bytes` instead of
 * `picture.bytes` in `prepareNoteImages`, name the upload link's leaf from the
 * sniffed type instead of the stored one, or drop the attach from
 * `attachImageUploads`.
 *
 * A picture texted to Tex (`textedPictures.js`) is named before it is stored, from the bytes that came in
 * (`upload-<hash>.png`), and stored compressed (`upload-<hash>.webp`): from 2026-11-01 to 2026-11-23 every texted
 * picture read back "not found" from Tex's history, which asked for the first name. Sabotage: drop the read-back in
 * `keepTextedPictures` (its leaf says .png), or the `embeddedUploadLeaf` fallback in `toolReadImage` (the .png ask
 * reads not found).
 */
import { createHash } from "node:crypto";
import { check, call, contextStore, env, worker } from "./harness.mjs";
import { keepTextedPictures } from "../../../packages/tex/gateway/agent/textedPictures.js";

const bytesOf = (head, length, fill = 0) => {
  const out = new Uint8Array(length).fill(fill);
  out.set(head);
  return out;
};
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 3000, 7);
const LINK_PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 3000, 9);
const GIF = bytesOf(new TextEncoder().encode("GIF89a"), 400, 3);
const WEBP = bytesOf(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), 300, 5);
const NOTE = "1-projects/portable/compressed-picture.md";
const LINKED_NOTE = "1-projects/portable/compressed-upload.md";

const text = (result) => result?.content?.[0]?.text ?? "";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fakeImages() {
  const binding = {
    calls: 0,
    input() {
      binding.calls += 1;
      const chain = { transform: () => chain, output: async () => ({ response: () => new Response(WEBP) }) };
      return chain;
    },
  };
  return binding;
}

async function stored(key) {
  const object = await contextStore.get(key);
  return object ? { bytes: new Uint8Array(await object.arrayBuffer()), type: object.httpMetadata?.contentType ?? null } : null;
}

export async function runPictureCompressionChecks() {
  const images = fakeImages();
  env.IMAGES = images;
  try {
    // -- write_note with a base64 picture
    const written = await call("priv-token", "write_note", {
      path: NOTE,
      content: "# Shot\n\n![[shot.png|320]]\n",
      images: [{ name: "shot.png", data: Buffer.from(PNG).toString("base64") }],
    });
    const leaf = `upload-${sha(PNG).slice(0, 16)}.webp`;
    check("a picture attached to write_note is stored as the encoder's WebP, named from the bytes that came in", !written?.isError && text(written).includes(leaf));
    const object = await stored(`.context/assets/images/${leaf}`);
    check("the stored bytes are the compressed copy", object !== null && Buffer.from(object.bytes).equals(Buffer.from(WEBP)));
    check("no lossless copy is kept beside it", (await stored(`.context/assets/images/upload-${sha(PNG).slice(0, 16)}.png`)) === null);
    const body = await contextStore.get(NOTE).then((o) => o?.text());
    check("the note embeds the compressed leaf, keeping its width", body?.includes(`![[${leaf}|320]]`));
    const readBack = await call("priv-token", "read_image", { note: NOTE, image: leaf });
    const block = readBack?.content?.find((b) => b.type === "image");
    check("the compressed picture reads back through read_image as a WebP", block?.mimeType === "image/webp" && block?.data === Buffer.from(WEBP).toString("base64"));

    const again = await call("priv-token", "write_note", {
      path: "1-projects/portable/compressed-picture-2.md",
      content: "# Again\n",
      images: [{ name: "again.png", data: Buffer.from(PNG).toString("base64") }],
    });
    check("the same picture sent again is the same object", text(again).includes(leaf));

    // -- a GIF is kept as it came
    const before = images.calls;
    const gif = await call("priv-token", "write_note", {
      path: "1-projects/portable/moving-picture.md",
      content: "# Moving\n",
      images: [{ name: "moving.gif", data: Buffer.from(GIF).toString("base64") }],
    });
    const gifLeaf = `upload-${sha(GIF).slice(0, 16)}.gif`;
    const gifObject = await stored(`.context/assets/images/${gifLeaf}`);
    check("a GIF never reaches the encoder and is stored byte for byte", images.calls === before && !gif?.isError && gifObject !== null && Buffer.from(gifObject.bytes).equals(Buffer.from(GIF)));

    // -- an upload link
    const asked = await call("priv-token", "write_note", { path: NOTE, upload: [{ name: "link.png", sha256: sha(LINK_PNG), bytes: LINK_PNG.byteLength }] });
    const match = text(asked).match(/Authorization: Bearer ([^']+)' --data-binary @'[^']+' (\S+)/);
    const response = await worker.fetch(
      new Request(match[2], { method: "PUT", headers: { Authorization: `Bearer ${match[1]}` }, body: LINK_PNG }),
      env,
      { waitUntil() {} },
    );
    const sent = await response.json();
    const linkLeaf = `upload-${sha(LINK_PNG)}.webp`;
    check("an upload link stores the compressed copy under the whole hash of the bytes sent", response.status === 201 && sent.stored === linkLeaf && sent.storedBytes === WEBP.byteLength);
    const linkObject = await stored(`.context/assets/images/${linkLeaf}`);
    check("its stored bytes are the WebP", linkObject !== null && Buffer.from(linkObject.bytes).equals(Buffer.from(WEBP)));
    const embedded = await call("priv-token", "write_note", {
      path: LINKED_NOTE,
      content: "# Linked\n\n![[link.png]]\n",
      images: [{ name: "link.png", sha256: sha(LINK_PNG) }],
    });
    const linked = await contextStore.get(LINKED_NOTE).then((o) => o?.text());
    check("write_note finds the uploaded picture by the sha256 the agent declared", !embedded?.isError && linked?.includes(`![[${linkLeaf}]]`));

    // -- a write's pictures are compressed all at once, not one after another
    let running = 0;
    let most = 0;
    env.IMAGES = {
      input() {
        const chain = {
          transform: () => chain,
          output: async () => {
            running += 1;
            most = Math.max(most, running);
            await new Promise((resolve) => setTimeout(resolve, 20));
            running -= 1;
            return { response: () => new Response(WEBP) };
          },
        };
        return chain;
      },
    };
    const three = [1, 2, 3].map((n) => bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 3000, 20 + n));
    const many = await call("priv-token", "write_note", {
      path: "1-projects/portable/three-pictures.md",
      content: "# Three\n\n![[a.png]]\n\n![[b.png]]\n\n![[c.png]]\n",
      images: three.map((bytes, i) => ({ name: `${"abc"[i]}.png`, data: Buffer.from(bytes).toString("base64") })),
    });
    const manyBody = await contextStore.get("1-projects/portable/three-pictures.md").then((o) => o?.text());
    check(
      "a write's pictures are compressed at the same time, each stored and embedded in its own place",
      !many?.isError && most === 3 &&
        three.every((bytes, i) => manyBody?.includes(`![[upload-${sha(bytes).slice(0, 16)}.webp]]`) && manyBody.indexOf(sha(bytes).slice(0, 16)) > manyBody.indexOf("# Three")) &&
        manyBody.indexOf(sha(three[0]).slice(0, 16)) < manyBody.indexOf(sha(three[1]).slice(0, 16)) &&
        manyBody.indexOf(sha(three[1]).slice(0, 16)) < manyBody.indexOf(sha(three[2]).slice(0, 16)),
    );

    // -- a picture texted to Tex, kept, then read back from its history by the name Tex holds
    const TEXTED = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 3000, 11);
    const textedHash = sha(TEXTED).slice(0, 16);
    const dispatch = (name, args) => call("priv-token", name, args);
    const kept = await keepTextedPictures(dispatch, { now: Date.parse("2026-11-23T07:37:00Z"), timeZone: "America/New_York", attachments: [{ name: "IMG_3335.png", mediaType: "image/png", data: Buffer.from(TEXTED).toString("base64") }], folder: "tex/pictures" });
    check("a texted picture is kept under the name the store gave it, the compressed one", kept.length === 1 && kept[0].leaf === `upload-${textedHash}.webp`);
    const pictures = kept[0]?.note ?? "tex/pictures/2026-11.md";
    const byKept = await call("priv-token", "read_image", { note: pictures, image: kept[0]?.leaf });
    check("Tex reads a kept texted picture back by the name it holds", byKept?.content?.find((part) => part.type === "image")?.mimeType === "image/webp");
    // A history recorded before this fix holds the name the picture came in under.
    const byOld = await call("priv-token", "read_image", { note: pictures, image: `upload-${textedHash}.png` });
    check("a texted picture named by its incoming type (.png) still reads back: the note embeds the same hash as .webp", byOld?.content?.find((part) => part.type === "image")?.data === Buffer.from(WEBP).toString("base64"));
    const otherHash = await call("priv-token", "read_image", { note: pictures, image: `upload-${"0".repeat(16)}.png` });
    check("a hash the note does not embed is not found under any extension", otherHash?.isError === true && text(otherHash) === "not found");
    const elsewhere = await call("priv-token", "read_image", { note: NOTE, image: `upload-${textedHash}.png` });
    check("the same hash asked through a note that does not embed it is not found", elsewhere?.isError === true && text(elsewhere) === "not found");
  } finally {
    delete env.IMAGES;
  }
}
