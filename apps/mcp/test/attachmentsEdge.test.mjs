import { check, call, contextStore, controlPlane, worker, suite } from "./harness.mjs";
import {
  PNG_BYTES,
  PNG_BASE64,
  TEAM_IMAGE,
  PRIVATE_IMAGE,
  SHARED_IMAGE,
  SCRIPT_OBJECT,
  REFUSAL,
  refusalText,
} from "./attachmentsFixtures.mjs";

export async function runAttachmentsEdgeChecks() {
  // -- read_image is not a general object reader
  //
  // The sharpest way this tool could go wrong: it reads bytes by key, and every
  // other read path in this gateway is gated on `.md` + canSee. If `image` were
  // allowed to name anything, a note saying "privacy.md" would exfiltrate the
  // manifest, and "../" would walk out of the store entirely.
  //
  // Each of these is asked through a note that *does* name the target, so the
  // reference check cannot be what refuses them. Without that the checks pass on
  // the strength of a different guard and prove nothing about this one — which is
  // how they were first written, and sabotaging the key shape did not turn a
  // single one red.
  const HOSTILE_TARGETS = [
    ["the privacy manifest", "privacy.md"],
    ["a note", "1-projects/secret-thing/status.md"],
    ["a traversal attempt", "../../privacy.md"],
    ["other plumbing", ".history/1-projects/portable/with-image.md"],
    ["a nested path inside the image store", ".context/assets/images/nested/../../privacy.md"],
  ];
  await contextStore.put(
    "1-projects/portable/hostile-refs.md",
    `# team note\n\n${HOSTILE_TARGETS.map(([, target]) => `![x](${target})`).join("\n")}\n`
  );
  for (const [label, target] of HOSTILE_TARGETS) {
    const attempt = await call("priv-token", "read_image", {
      note: "1-projects/portable/hostile-refs.md",
      image: target,
    });
    check(`read_image cannot be pointed at ${label}`, refusalText(attempt) === REFUSAL);
  }
  const scriptObject = await call("priv-token", "read_image", {
    note: "1-projects/portable/with-script.md",
    image: `.context/assets/images/${SCRIPT_OBJECT}`,
  });
  check(
    "an object in .images that is not an image type resolves nothing",
    refusalText(scriptObject) === REFUSAL
  );

  // -- SVG is an image everywhere except here
  //
  // The check above cannot cover this one, and that is the whole reason it needs
  // its own. `.sh` is refused because nothing would call it an image; `.svg` is
  // refused *although* it is one. It is a script container — an `<svg>` can carry
  // `<script>` and event handlers — and this gateway hands bytes plus a MIME type
  // to a client that renders what it is given. `image/svg+xml` in the type map is
  // therefore a one-line XSS in whatever displays it.
  //
  // This was found by sabotage during review: adding `["svg", "image/svg+xml"]`
  // to IMAGE_MIME_TYPES turned nothing red across the whole suite, even though
  // "SVG is deliberately not storable and not servable" was written down as a
  // decision. A decision nothing enforces is a comment.
  const SVG_OBJECT = `${"d".repeat(64)}.svg`;
  await contextStore.put(
    `.context/assets/images/${SVG_OBJECT}`,
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  );
  await contextStore.put(
    "1-projects/portable/with-svg.md",
    `# team note\n\n![a diagram](.context/assets/images/${SVG_OBJECT})\n`
  );
  const svgObject = await call("priv-token", "read_image", {
    note: "1-projects/portable/with-svg.md",
    image: `.context/assets/images/${SVG_OBJECT}`,
  });
  check("an SVG is never served, however it is referenced", refusalText(svgObject) === REFUSAL);
  check(
    "and no response ever claims the SVG media type",
    !JSON.stringify(svgObject).includes("svg+xml")
  );

  // -- the chunked base64 path, and the inline ceiling
  //
  // `base64FromBytes` walks the image in 32KB chunks because String.fromCharCode
  // cannot be handed a megabyte of arguments. A 13-byte fixture never reaches the
  // second chunk, so it cannot tell a correct loop from an off-by-one one: this
  // image crosses the boundary and carries every byte value, so a truncating or
  // overlapping chunk changes the base64 and the check goes red.
  const BIG_IMAGE = `${"1".repeat(64)}.jpg`;
  const BIG_BYTES = new Uint8Array(70_000);
  for (let i = 0; i < BIG_BYTES.length; i += 1) BIG_BYTES[i] = (i * 31 + 7) % 256;
  await contextStore.put(`.context/assets/images/${BIG_IMAGE}`, BIG_BYTES);
  await contextStore.put(
    "1-projects/portable/big-image.md",
    `# team note\n\n![big](.context/assets/images/${BIG_IMAGE})\n`
  );
  const bigImage = await call("priv-token", "read_image", {
    note: "1-projects/portable/big-image.md",
    image: `.context/assets/images/${BIG_IMAGE}`,
  });
  check(
    "an image larger than one base64 chunk round-trips byte for byte",
    bigImage.content?.find((block) => block.type === "image")?.data ===
      Buffer.from(BIG_BYTES).toString("base64")
  );
  check(
    "the mime type follows the extension, not a guess",
    bigImage.content?.find((block) => block.type === "image")?.mimeType === "image/jpeg"
  );

  // The one refusal that is allowed to say what it is. Reaching it already proves
  // the caller can see a note referencing the image, so there is nothing left to
  // conceal — and a silent "not found" here would send someone hunting for a
  // missing object that is present and merely too big.
  const HUGE_IMAGE = `${"2".repeat(64)}.png`;
  await contextStore.put(`.context/assets/images/${HUGE_IMAGE}`, new Uint8Array(5_000_001));
  await contextStore.put(
    "1-projects/portable/huge-image.md",
    `# team note\n\n![huge](.context/assets/images/${HUGE_IMAGE})\n`
  );
  const hugeImage = await call("priv-token", "read_image", {
    note: "1-projects/portable/huge-image.md",
    image: `.context/assets/images/${HUGE_IMAGE}`,
  });
  check(
    "an oversized image is refused by size, and says so rather than hiding",
    hugeImage.isError === true && hugeImage.content[0].text.includes("too large")
  );
  check(
    "...but a caller who cannot see the note still only gets not found",
    refusalText(
      await call("team-token", "read_image", {
        note: "1-projects/secret-thing/with-image.md",
        image: `.context/assets/images/${PRIVATE_IMAGE}`,
      })
    ) === REFUSAL
  );

  // The image store is flat. A nested key inside it is not addressable, so the
  // leaf can never be a path — the check that stops `.context/assets/images/a/b.png` is the same
  // one that stops `.context/assets/images/../../privacy.md` once the traversal filter is gone.
  await contextStore.put(`.context/assets/images/nested/${TEAM_IMAGE}`, PNG_BYTES);
  await contextStore.put(
    "1-projects/portable/nested-ref.md",
    `# team note\n\n![nested](.context/assets/images/nested/${TEAM_IMAGE})\n`
  );
  check(
    "a nested key inside the image store is not addressable",
    refusalText(
      await call("priv-token", "read_image", {
        note: "1-projects/portable/nested-ref.md",
        image: `.context/assets/images/nested/${TEAM_IMAGE}`,
      })
    ) === REFUSAL
  );

  // -- derived visibility, stated out loud
  //
  // An image has no visibility of its own; it borrows the visibility of whatever
  // note reaches it. So one image referenced by both a private note and a team
  // note is reachable by the team connection — through the team note, and only
  // through it. That is correct (the team note has to display it) and it is the
  // single most surprising consequence of the design, which is why it is a named
  // check rather than a footnote.
  const teamViaTeamNote = await call("team-token", "read_image", {
    note: "1-projects/portable/shared-image.md",
    image: `.context/assets/images/${SHARED_IMAGE}`,
  });
  check(
    "an image referenced by both a private and a team note is team-reachable via the team note",
    !teamViaTeamNote.isError &&
      teamViaTeamNote.content?.find((block) => block.type === "image")?.data === PNG_BASE64
  );
  check(
    "...and still unreachable through the private note that also references it",
    refusalText(
      await call("team-token", "read_image", {
        note: "1-projects/secret-thing/shared-image.md",
        image: `.context/assets/images/${SHARED_IMAGE}`,
      })
    ) === REFUSAL
  );

  // -- the contract with the email worker
  //
  // The two halves of this feature live in different packages and neither can
  // import the other. The worker decides the key and writes the link; the gateway
  // decides what it will resolve. If those drift, mail silently produces images
  // nothing can fetch — and every test on both sides stays green, because each
  // one is right about its own half.
  //
  // So this asserts the join: a note in exactly the shape
  // `renderCaptureNote` emits, resolving through the real tool.
  const CAPTURE_IMAGE = `${"9".repeat(64)}.png`;
  await contextStore.put(`.context/assets/images/${CAPTURE_IMAGE}`, PNG_BYTES);
  await contextStore.put(
    "1-projects/portable/email-capture.md",
    [
      "---",
      'source: "email"',
      "attachments: 1",
      "---",
      "",
      "## Attachments",
      "",
      // Byte-for-byte the line infra/email-worker/src/note.ts writes.
      `- ![shot.png](.context/assets/images/${CAPTURE_IMAGE}) — image/png, 1.2 KB`,
      "",
      "_Attachment files came from the same untrusted sender as the text above._",
      "",
    ].join("\n")
  );
  const fromCapture = await call("priv-token", "read_image", {
    note: "1-projects/portable/email-capture.md",
    image: `.context/assets/images/${CAPTURE_IMAGE}`,
  });
  check(
    "an image the email worker stored resolves from the note it wrote",
    !fromCapture.isError &&
      fromCapture.content?.find((block) => block.type === "image")?.data === PNG_BASE64
  );
  check(
    "...and the capture note itself is still an ordinary readable note",
    !(await call("priv-token", "read_note", { path: "1-projects/portable/email-capture.md" })).isError
  );

  // -- the store stays opaque
  //
  // Adding a way in must not have added a way to enumerate. These are the same
  // guarantees `isPlumbing` gave before this tool existed, re-asserted after it.
  const listedAfterImages = await call("priv-token", "list_notes", {});
  check(
    "no image appears in a listing, at any scope",
    !listedAfterImages.content[0].text.includes(".context/assets/images/")
  );
  check(
    "an image prefix lists nothing rather than listing the store",
    !(await call("priv-token", "list_notes", { prefix: ".images" })).content[0].text.includes(TEAM_IMAGE)
  );
  // Searching for the hash *does* match the note that references it, which is
  // right. The guarantee is about the store itself: markdown sitting inside
  // `.context/assets/images/` is not note surface and must never be searchable. (Seeded at the
  // top of this section, so the listing checks above cover it as well.)
  check(
    "search never reaches inside the image store",
    !(await call("priv-token", "search_notes", { query: "IMAGESTOREMARKER" })).content[0].text.includes(
      "IMAGESTOREMARKER"
    )
  );
  check(
    "read_note still cannot read an image",
    (await call("priv-token", "read_note", { path: `.context/assets/images/${TEAM_IMAGE}` })).isError === true
  );


  // -- storage adapters: signing, listing, rootPrefix, capability probe
  // The cron checks above replaced globalThis.fetch wholesale to serve an ICS
  // feed. Everything below authenticates through the control plane again.
  controlPlane.install();
  /*
    AND THE WRAPPER'S OWN GUARD, BECAUSE A GUARD NOBODY HAS CHECKED IS NOT ONE.

    Two things, and the second is the whole point: a throwing suite becomes one
    named failure, **and the suite queued behind it still runs**. A wrapper that
    caught and re-threw would pass the first of these and fail the second, which
    is the shape that was already in the tree.

    Its own `report` so the deliberate throws below are not counted or printed —
    a FAIL line nobody should act on is how a suite teaches people to skim past
    FAIL lines.
  */
  {
    const reported = [];
    const collect = (label) => reported.push(label);
    let secondRan = false;
    await suite("a suite that throws", () => {
      throw new Error("boom");
    }, collect);
    await suite("the one behind it", () => {
      secondRan = true;
    }, collect);
    check(
      "a suite that throws is one named failure, naming the suite and the reason",
      reported.length === 1 && reported[0].includes("a suite that throws") && reported[0].includes("boom")
    );
    check("...and the suite queued behind it still runs", secondRan === true);
    await suite("an async suite that rejects", async () => {
      throw new Error("later");
    }, collect);
    check("...and a rejected promise is caught the same way", reported.length === 2 && reported[1].includes("later"));
  }


}
