/**
 * `write_note`'s `images` argument: an agent attaching a picture to a note.
 *
 * What has to hold: the bytes land in the opaque store under a content-hashed
 * leaf, the note embeds that leaf and never the bytes or a remote URL, the
 * image comes back out through `read_image` via the note, and nothing is
 * fetched or stored for a write that was going to be refused.
 */
import { check, call, contextStore } from "./harness.mjs";

// A real PNG signature followed by bytes that are not valid UTF-8, so a
// pipeline that turned the bytes into text would fail the round trip.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80, 0x07]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const text = (result) => result.content?.[0]?.text ?? "";
const leafIn = (result) => text(result).match(/upload-[0-9a-f]{16}\.(png|jpg|gif|webp|heic|heif)/)?.[0];

async function storedBytes(key) {
  const object = await contextStore.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

async function noteText(path) {
  const object = await contextStore.get(path);
  return object ? await object.text() : null;
}

/** Serve `routes` for their exact URLs, and hand everything else to the real stub. */
function withFetch(routes, run) {
  const prior = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (Object.hasOwn(routes, url)) {
      requested.push(url);
      return routes[url]();
    }
    if (/^https:\/\/[a-z.]+\.example\//.test(url)) {
      requested.push(url);
      return new Response("no route", { status: 404 });
    }
    return prior(input, init);
  };
  return run(requested).finally(() => {
    globalThis.fetch = prior;
  });
}

export async function runUploadedImageChecks() {
  // -- base64, embedded by name
  const written = await call("priv-token", "write_note", {
    path: "1-projects/portable/diagram-note.md",
    content: "# Diagram\n\nHere it is:\n\n![[chart.png|480]]\n\nAnd ![inline](chart.png) too.\n",
    images: [{ name: "chart.png", data: PNG_B64 }],
  });
  const leaf = leafIn(written);
  check("write_note with a base64 image succeeds and names the stored leaf", !written.isError && Boolean(leaf));
  const stored = await storedBytes(`.context/assets/images/${leaf}`);
  check(
    "the bytes are stored in the opaque image store, byte for byte",
    stored !== null && Buffer.from(stored).equals(Buffer.from(PNG))
  );
  const body = await noteText("1-projects/portable/diagram-note.md");
  check(
    "every embed of the placeholder now points at the stored leaf, keeping its width and link style",
    body?.includes(`![[${leaf}|480]]`) && body?.includes(`![inline](${leaf})`) && !body?.includes("chart.png")
  );
  check("the note never carries the image bytes", !body?.includes(PNG_B64) && !body?.includes("data:"));
  const readBack = await call("priv-token", "read_image", {
    note: "1-projects/portable/diagram-note.md",
    image: leaf,
  });
  check(
    "the attached image reads back through read_image via its note",
    readBack.content?.find((block) => block.type === "image")?.data === PNG_B64
  );

  // -- content-addressed: the same bytes are one object
  const again = await call("priv-token", "write_note", {
    path: "1-projects/portable/diagram-note-2.md",
    content: "# Same picture\n",
    images: [{ name: "same.png", data: `data:image/png;base64,${PNG_B64}`, alt: "the [same] chart" }],
  });
  check("the same image attached again is the same leaf", leafIn(again) === leaf);
  check(
    "an image the content does not embed is appended, with its alt text made safe for the link",
    (await noteText("1-projects/portable/diagram-note-2.md"))?.endsWith(`![[${leaf}|the  same  chart]]\n`)
  );

  // -- the type comes from the bytes
  const lying = await call("priv-token", "write_note", {
    path: "1-projects/portable/svg-note.md",
    content: "![[x.png]]\n",
    images: [{ name: "x.png", data: `data:image/png;base64,${Buffer.from(SVG).toString("base64")}` }],
  });
  check(
    "an SVG declared as PNG is refused, and the note is not written",
    lying.isError === true &&
      text(lying).includes("SVG is never stored") &&
      (await noteText("1-projects/portable/svg-note.md")) === null
  );
  const jpeg = await call("priv-token", "write_note", {
    path: "1-projects/portable/photo-note.md",
    content: "![[photo.png]]\n",
    images: [{ name: "photo.png", data: Buffer.from(JPEG).toString("base64") }],
  });
  check("a JPEG named .png is stored as the JPEG it is", leafIn(jpeg)?.endsWith(".jpg"));

  for (const [label, images, expected] of [
    ["neither data nor url", [{ name: "a.png" }], "exactly one of data"],
    ["both data and url", [{ name: "a.png", data: PNG_B64, url: "https://img.example/a.png" }], "exactly one of data"],
    ["junk base64", [{ name: "a.png", data: "not base64!!" }], "must be base64"],
    ["a name that would break the link", [{ name: "a]].png", data: PNG_B64 }], "name must be"],
    ["two images with one name", [{ name: "a.png", data: PNG_B64 }, { name: "a.png", data: PNG_B64 }], "two images are named"],
    ["too many images", Array.from({ length: 11 }, (_, i) => ({ name: `a${i}.png`, data: PNG_B64 })), "10"],
    ["too large", [{ name: "a.png", data: "A".repeat(7_000_000) }], "5000000"],
    [
      "too large together",
      Array.from({ length: 4 }, (_, i) => ({ name: `big${i}.png`, data: Buffer.concat([Buffer.from(PNG), Buffer.alloc(4_000_000 + i)]).toString("base64") })),
      "split them across writes",
    ],
  ]) {
    const refused = await call("priv-token", "write_note", {
      path: "1-projects/portable/refused-image.md",
      content: "x\n",
      images,
    });
    check(`images: ${label} is refused`, refused.isError === true && text(refused).includes(expected));
  }
  check("no refused image write created its note", (await noteText("1-projects/portable/refused-image.md")) === null);

  // -- permission first: a refused write stores and fetches nothing
  await withFetch(
    { "https://img.example/private.png": () => new Response(PNG, { status: 200 }) },
    async (requested) => {
      const denied = await call("team-token", "write_note", {
        path: "1-projects/secret-thing/team-cannot-write.md",
        content: "![[p.png]]\n",
        images: [{ name: "p.png", url: "https://img.example/private.png" }],
      });
      check(
        "a team connection refused a private destination fetched nothing",
        denied.isError === true && requested.length === 0
      );
    }
  );

  // -- url: fetched once, stored, embedded as the workspace copy
  await withFetch(
    {
      "https://img.example/logo.png": () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
      "https://img.example/moved.png": () =>
        new Response(null, { status: 302, headers: { location: "/logo.png" } }),
      "https://img.example/downgrade.png": () =>
        new Response(null, { status: 302, headers: { location: "http://img.example/logo.png" } }),
      "https://img.example/page.html": () =>
        new Response("<html><body>hi</body></html>", { status: 200, headers: { "content-type": "image/png" } }),
      "https://img.example/huge.png": () =>
        new Response(new Uint8Array(6_000_000), { status: 200 }),
    },
    async (requested) => {
      const fromUrl = await call("team-token", "write_note", {
        path: "1-projects/portable/from-url.md",
        content: "# Logo\n\n![logo](logo.png)\n",
        images: [{ name: "logo.png", url: "https://img.example/logo.png" }],
      });
      const urlBody = await noteText("1-projects/portable/from-url.md");
      check(
        "a url image is fetched, stored, and embedded as the workspace copy",
        !fromUrl.isError && leafIn(fromUrl) === leaf && urlBody?.includes(`![logo](${leaf})`)
      );
      check("the note never names the remote host", !urlBody?.includes("img.example"));
      const redirected = await call("team-token", "write_note", {
        path: "1-projects/portable/from-redirect.md",
        content: "![[m.png]]\n",
        images: [{ name: "m.png", url: "https://img.example/moved.png" }],
      });
      check("a same-scheme redirect is followed", !redirected.isError && leafIn(redirected) === leaf);
      for (const [label, url, expected] of [
        ["plain http", "http://img.example/logo.png", "https address"],
        ["a url with a password", "https://user:pw@img.example/logo.png", "https address"],
        ["a non-default port", "https://img.example:8443/logo.png", "https address"],
        ["localhost", "https://localhost/logo.png", "https address"],
        ["an IP address", "https://127.0.0.1/logo.png", "https address"],
        ["an IPv6 address", "https://[::1]/logo.png", "https address"],
        ["a redirect down to http", "https://img.example/downgrade.png", "redirected"],
        ["a page served as image/png", "https://img.example/page.html", "not a PNG"],
        ["an image over the ceiling", "https://img.example/huge.png", "larger than"],
        ["a url that is not found", "https://img.example/missing.png", "404"],
      ]) {
        const refused = await call("team-token", "write_note", {
          path: "1-projects/portable/refused-url.md",
          content: "x\n",
          images: [{ name: "u.png", url }],
        });
        check(`url: ${label} is refused`, refused.isError === true && text(refused).includes(expected));
      }
      check(
        "a refused scheme or host was never requested",
        !requested.some((url) => url.startsWith("http:") || url.includes("localhost") || url.includes(":8443") || url.includes("127.0.0.1") || url.includes("[::1]"))
      );
    }
  );

  // -- an encrypted note refuses an attachment, as a paste does
  await contextStore.put(
    "1-projects/portable/sealed.md",
    "---\ncontext_encryption: v1\n---\nciphertext\n"
  );
  const sealed = await contextStore.get("1-projects/portable/sealed.md");
  const onSealed = await call("priv-token", "write_note", {
    path: "1-projects/portable/sealed.md",
    content: "![[s.png]]\n",
    expected_etag: sealed.etag,
    images: [{ name: "s.png", data: PNG_B64 }],
  });
  check(
    "an encrypted note refuses an attached image before anything is stored",
    onSealed.isError === true && text(onSealed).includes("encrypted")
  );
}
