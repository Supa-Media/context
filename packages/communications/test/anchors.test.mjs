// Anchors: the stable link target inside a day.
//
// SABOTAGE RECORD
//   join the anchor fields with `-` instead of NUL        -> 1 check failed
//   key a thread off its first message's anchor           -> 5 checks failed
//   return a 12-character anchor                          -> 3 checks failed
//   hash UTF-16 code units instead of UTF-8 bytes         -> 1 check failed
//   drop `account` from the thread key input              -> 1 check failed
//   drop `account` from the anchor input                  -> 2 checks failed

import { ANCHOR_HEX_LENGTH, ANCHOR_PREFIX } from "../src/protocol.js";
import { fnv1a64, isMessageAnchor, messageAnchor, threadKey } from "../src/anchors.js";
import { message } from "./fixtures.mjs";

export function runAnchorChecks(check) {
  const one = message();

  check("an anchor is the prefix and a fixed number of hex characters", isMessageAnchor(messageAnchor(one)));
  check(
    "...and is exactly that long, so a heading id never varies in width",
    messageAnchor(one).length === ANCHOR_PREFIX.length + ANCHOR_HEX_LENGTH
  );
  check("the same message twice is the same anchor", messageAnchor(one) === messageAnchor(message()));
  check(
    "...and stays the same when everything a sender can edit changes",
    messageAnchor(one) ===
      messageAnchor(message({ subject: "Re: something else", body: "different", sentAt: "2026-09-08T00:00:00.000Z" }))
  );
  check("a different message id is a different anchor", messageAnchor(one) !== messageAnchor(message({ messageId: "<b@mail.example.net>" })));
  check(
    "the same message id on a different account is a different anchor",
    messageAnchor(one) !== messageAnchor(message({ account: "other-at-example-com" }))
  );
  check(
    "...and on a different channel too",
    messageAnchor(one) !== messageAnchor(message({ channel: "imessage" }))
  );
  /*
    Two mailboxes, one provider. The same `Message-ID:` arrives in both — the
    ordinary case of being cc'd at work and at home — and the anchors must not
    match, or an anchor becomes a join key across two folders whose whole
    purpose is that `privacy.md` can give them different visibilities.
  */
  check(
    "the same message in two mailboxes is not the same anchor",
    (() => {
      const id = "<shared@mail.example.net>";
      return (
        messageAnchor(message({ account: "work-at-example-com", messageId: id })) !==
        messageAnchor(message({ account: "home-at-example-net", messageId: id }))
      );
    })()
  );
  check(
    "...and neither is its thread key",
    threadKey(message({ account: "work-at-example-com", threadId: "t" })) !==
      threadKey(message({ account: "home-at-example-net", threadId: "t" }))
  );

  check(
    "the fields cannot be shifted across the separator",
    messageAnchor(message({ account: "a", messageId: "b" })) !== messageAnchor(message({ account: "a\u0000b", messageId: "" }))
  );
  check(
    "...and the separator is one no field can contain, so a hyphen cannot forge it",
    messageAnchor(message({ account: "a", messageId: "b-c" })) !== messageAnchor(message({ account: "a-b", messageId: "c" }))
  );

  check("no raw provider id survives into the anchor", !messageAnchor(one).includes("mail.example.net"));
  check(
    "...whatever the provider wrote in it",
    !messageAnchor(message({ messageId: "<../../privacy.md@x>" })).includes("privacy.md")
  );
  check(
    "an anchor is filename- and heading-safe by construction",
    /^msg-[0-9a-f]+$/.test(messageAnchor(message({ messageId: "a b/c\n{}#" })))
  );

  check("a thread key is not a message anchor", threadKey(one) !== messageAnchor(one));
  check("...even when the provider gives a message and its thread the same id", threadKey(message({ threadId: "x", messageId: "x" })) !== messageAnchor(message({ threadId: "x", messageId: "x" })));
  check("two messages in one thread share a key", threadKey(one) === threadKey(message({ messageId: "<other@mail.example.net>" })));
  check(
    "a message with no thread id is its own thread, not everybody's",
    threadKey(message({ threadId: "", messageId: "<a@x>" })) !== threadKey(message({ threadId: "", messageId: "<b@x>" }))
  );

  // The hash itself. Bytes rather than code units, so the same string hashes
  // the same whatever produced it.
  check("the hash is stable", fnv1a64("abc") === fnv1a64("abc"));
  check("...and 16 hex characters wide, zero-padded", /^[0-9a-f]{16}$/.test(fnv1a64("")));
  /*
    Against values computed independently (Python, over the same UTF-8 bytes),
    not against this implementation's own output. The non-ASCII one is the
    check that matters: hashing UTF-16 code units instead of UTF-8 bytes
    passes every ASCII test and fails this.
  */
  check("...and agrees with FNV-1a 64 as everybody else computes it", fnv1a64("abc") === "e71fa2190541574b");
  check("...over UTF-8 bytes rather than UTF-16 code units", fnv1a64("\u00e9") === "0ac21707b7181e01");
  check("...and the empty string is the offset basis", fnv1a64("") === "cbf29ce484222325");
  check(
    "a composed character and its decomposition are different bytes, and hash differently",
    fnv1a64("\u00e9") !== fnv1a64("e\u0301")
  );
  check("a not-an-anchor is not accepted", !isMessageAnchor("msg-0123") && !isMessageAnchor("0123456789abcdef"));
}
