/**
 * Dropbox is the one-click tier: a folder in somebody's Dropbox rather than a
 * bucket they had to create. These checks prove it is a real ContextStore and
 * not a degraded one — above the adapter nothing may learn which backend it got.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { DropboxStore, dbxTagged, probeStore, dropbox, dbxJson } from "./fixtures.mjs";

export async function runStoreDropboxChecks(check) {
  /* ------------------------------- Dropbox -------------------------------- */

  /**
   * Dropbox is the one-click tier: a folder in somebody's Dropbox rather than a
   * bucket they had to create. The point of these checks is that it is a real
   * ContextStore and not a degraded one — above the adapter nothing may learn
   * which backend it got.
   */

  {
    const store = dropbox(() => dbxJson({ rev: "0157f8" }));
    const written = await store.put("1-projects/foo.md", "hello");
    const call = store.fetch.calls[0];
    const arg = JSON.parse(call.headers["Dropbox-API-Arg"]);
    check(
      "dropbox writes to a path, with the leading slash Dropbox requires",
      arg.path === "/1-projects/foo.md"
    );
    check(
      "dropbox never autorenames around a conflict",
      arg.autorename === false
    );
    check("dropbox returns rev as the etag", written?.etag === "0157f8");
  }

  {
    // The whole reason this adapter does not report conditionalWrite: false.
    const store = dropbox(() => dbxJson({ rev: "b2" }));
    await store.put("a.md", "x", { onlyIf: { etagMatches: "a1" } });
    const arg = JSON.parse(store.fetch.calls[0].headers["Dropbox-API-Arg"]);
    check(
      "a conditional write becomes Dropbox's update mode carrying the rev",
      arg.mode?.[".tag"] === "update" && arg.mode?.update === "a1"
    );
  }

  {
    // Dropbox says 409 for a lost race; the contract says null.
    //
    // The body is the shape Dropbox actually sends. It used to be
    // `{ error_summary: "path/conflict/file/..", error: {} }` — an `error` with
    // no tag in it, which satisfied a `String.includes` over the raw body and
    // nothing else. A fixture that only passes the check being replaced is a
    // fixture written to the check rather than to the API.
    const conflictBody = {
      error_summary: "path/conflict/file/...",
      error: {
        ".tag": "path",
        reason: { ".tag": "conflict", conflict: { ".tag": "file" } },
      },
    };
    const store = dropbox(() => dbxJson(conflictBody, 409));
    const result = await store.put("a.md", "x", { onlyIf: { etagMatches: "stale" } });
    check("a lost conditional write is null, not an exception", result === null);
  }

  {
    // `null` means "your precondition failed" and nothing else.
    //
    // Dropbox answers `path/conflict/folder` when a folder sits at the path of
    // an ordinary overwrite. Returned as `null`, that tells `move_note` and
    // `archive_note` the destination was contended when it was simply never
    // written — and both delete the source on the next line. This is the only
    // backend that can derive `null` from something other than a precondition,
    // so it is the only one that needs the check.
    const store = dropbox(() =>
      dbxJson(
        {
          error_summary: "path/conflict/folder/...",
          error: {
            ".tag": "path",
            reason: { ".tag": "conflict", conflict: { ".tag": "folder" } },
          },
        },
        409
      )
    );
    let threw = null;
    let result = "unset";
    try {
      result = await store.put("a.md", "x");
    } catch (error) {
      threw = error;
    }
    check(
      "an unconditional write never returns null, whatever the conflict",
      result !== null && threw !== null
    );
  }

  {
    // The fake's own error shape, pinned — on the SHAPE, not on the tag it
    // walks to. Both the flattened and the nested form walk to
    // "path/conflict/file", so an assertion through `errorTagPath` cannot tell
    // them apart and proves nothing about the fixture.
    //
    // `UploadError.path` carries `UploadWriteFailed`, a struct, and Stone
    // flattens struct-valued union variants, so an upload conflict really is
    // `{".tag":"path", reason:{…}, upload_session_id:"…"}`. A lookup error
    // genuinely does nest. The derivation must get both right.
    const conflict = await dbxTagged("path/conflict/file/.").json();
    const lookup = await dbxTagged("path/restricted_content/.").json();
    check(
      "the shared fake emits the flattened upload shape",
      conflict.error?.[".tag"] === "path" &&
        conflict.error?.reason?.[".tag"] === "conflict" &&
        conflict.error?.reason?.conflict?.[".tag"] === "file" &&
        conflict.error?.path === undefined
    );
    check(
      "and the nested lookup shape, which is a different union",
      lookup.error?.[".tag"] === "path" &&
        lookup.error?.path?.[".tag"] === "restricted_content" &&
        lookup.error?.reason === undefined
    );
  }

  {
    // The 64 KB cap on an error body, which is one of this adapter's advertised
    // fixes and shipped with nothing guarding it. `s3.js` states the reason: a
    // body is buffered whole before anything trims it, so a hostile or broken
    // endpoint could stream hundreds of megabytes into a 128 MB isolate.
    const huge = "x".repeat(200_000);
    const store = dropbox(
      () =>
        new Response(
          JSON.stringify({
            error_summary: "path/not_found/..",
            error: { ".tag": "path", path: { ".tag": "not_found" } },
            padding: huge,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )
    );
    // Over the cap the body is not read at all, so no tag is found and the
    // absence is not mistaken for one — a failure, which is the safe direction.
    let threw = null;
    let result = "unset";
    try {
      result = await store.get("a.md");
    } catch (error) {
      threw = error;
    }
    check(
      "an oversized error body is capped rather than buffered whole",
      result !== null && threw !== null && !threw.message.includes("xxxxx")
    );
  }

  {
    // The `content-length` shortcut, which is the branch that normally fires.
    // `new Response(string)` carries no content-length in this runtime, so the
    // test above only exercises the streaming cap — while a real fetch response
    // usually does declare a length, making the *untested* branch the one
    // production takes. Not two halves of one control, as the Retry-After cap
    // was: the streaming cap is the real defence and is guarded. This covers
    // the cheap path as well as the safe one.
    //
    // The signal is `bodyUsed`, not a spy on `text()`: the streaming branch
    // reads through `body.getReader()`, so a `text()` counter stays at zero
    // whether the shortcut fires or not, and asserting on it proves nothing.
    const body = JSON.stringify({
      error_summary: "path/not_found/..",
      error: { ".tag": "path", path: { ".tag": "not_found" } },
      padding: "y".repeat(200_000),
    });
    let sent = null;
    const store = dropbox(() => {
      sent = new Response(body, {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
      });
      return sent;
    });
    let threw = null;
    let result = "unset";
    try {
      result = await store.get("a.md");
    } catch (error) {
      threw = error;
    }
    check(
      "a declared over-cap Content-Length is refused without reading the body",
      result !== null && threw !== null && sent.bodyUsed === false
    );
  }

  {
    // The tag decides, not the prose around it. Dropbox's `user_message` is
    // localized text; a note title or a refusal message containing the words
    // "not_found" must not turn a file that exists into a file that is gone.
    const store = dropbox(() =>
      dbxJson(
        {
          error_summary: "path/restricted_content/...",
          error: { ".tag": "path", path: { ".tag": "restricted_content" } },
          user_message: { text: "This file could not be downloaded (not_found)." },
        },
        409
      )
    );
    let threw = null;
    let result = "unset";
    try {
      result = await store.get("a.md");
    } catch (error) {
      threw = error;
    }
    check(
      "a 409 that merely mentions not_found is a failure, not an absence",
      result !== null && threw !== null
    );
  }

  {
    // These throws reach the connected AI client verbatim. Dropbox echoes the
    // offending path, which is the customer's folder plus the note's own name —
    // the thing `assertSafeKey`'s contract says a message must never carry.
    const store = dropbox(() =>
      dbxJson(
        {
          error_summary: "path/malformed_path/..",
          error: {
            ".tag": "path",
            path: {
              ".tag": "malformed_path",
              malformed_path: "/Private Journal/1-projects/acquisition-of-acme.md",
            },
          },
        },
        409
      )
    );
    let message = "";
    try {
      await store.get("1-projects/acquisition-of-acme.md");
    } catch (error) {
      message = error.message;
    }
    check(
      "a Dropbox failure names the tag and never the customer's path",
      message.includes("malformed_path") &&
        !message.includes("Private Journal") &&
        !message.includes("acquisition-of-acme")
    );
  }

  {
    // `Retry-After` is a number from outside the Worker, honoured up to four
    // times. Unbounded, `Retry-After: 86400` asks for ~96 hours of wall clock
    // inside one request.
    const slept = [];
    const store = dropbox(
      () => dbxJson({ error_summary: "too_many_requests" }, 429, { "Retry-After": "86400" }),
      { sleep: async (ms) => slept.push(ms) }
    );
    let surfaced = "";
    await store.get("a.md").catch((error) => {
      surfaced = error.message;
    });
    // `slept.length === 0`, not "every sleep was short". The claim is that the
    // caller gets the 429 back rather than waiting; asserting the sleeps were
    // bounded passes just as well if the cap is implemented by clamping, which
    // is a different behaviour. And `response !== undefined` was vacuous —
    // `.catch(() => "threw")` is never undefined.
    check("an outsized Retry-After is handed back, not slept through", slept.length === 0);
    // And the 429 reaches the caller as a 429, rather than the request sitting
    // on it. Asserting only that the sleeps were short would pass just as well
    // against a cap implemented by clamping, which is different behaviour.
    check("and the caller gets the 429 itself", surfaced.includes("429"));
  }

  {
    let threw = null;
    const store = dropbox(() => dbxJson({ rev: "z" }));
    try {
      await store.put("a.md", "x", { onlyIf: { etagMatches: "" } });
    } catch (error) {
      threw = error;
    }
    check(
      "an onlyIf with no usable etag is refused rather than silently overwriting",
      threw !== null && /refusing to downgrade/.test(threw.message)
    );
  }

  {
    // The rootPrefix seam, on all four operations rather than on `list` alone.
    //
    // `R2Store` has this check and Dropbox did not, and the asymmetry runs the
    // wrong way: an S3 or R2 credential is scoped to a bucket that holds
    // nothing but this context, so the prefix is a convenience. A Dropbox
    // token is scoped to an ACCOUNT, so until the binding says otherwise this
    // seam is the only thing standing between a workspace and the customer's
    // tax returns. Sabotage: drop `this._path()` from any one of get, put or
    // delete and this fails — before this check, only `list` noticed.
    const paths = [];
    const scoped = new DropboxStore({
      accessToken: "sl.FAKE-not-a-real-token",
      rootPrefix: "Private Journal",
      sleep: async () => {},
      fetch: async (url, init) => {
        const header = init?.headers?.["Dropbox-API-Arg"];
        if (header) paths.push(JSON.parse(header).path);
        else paths.push(JSON.parse(init.body).path);
        return dbxJson({ rev: "r1", entries: [], has_more: false });
      },
    });
    await scoped.get("1-projects/foo.md");
    await scoped.put("1-projects/foo.md", "x");
    await scoped.delete("1-projects/foo.md");
    await scoped.list({ prefix: "1-projects/" });
    check(
      "dropbox applies rootPrefix on read, write, delete and list alike",
      paths.length === 4 &&
        paths.every((path) => path.startsWith("/Private Journal/")) &&
        paths[3] === "/Private Journal/1-projects"
    );
  }

  {
    // The capability claim, proved rather than declared.
    //
    // `capabilities.conditionalWrite` is what CLAUDE.md's "probe capability at
    // connect time and degrade honestly" turns on, and the comment above it
    // says `probeStore()` proves it — which nothing did, because no test ever
    // built a DropboxStore and probed one. This runs the real probe against a
    // fake with Dropbox's own semantics: rev-per-write, `mode: update` honoured
    // as a precondition, 409-with-a-tag for absence.
    const files = new Map();
    let revs = 0;
    const probeFake = new DropboxStore({
      accessToken: "sl.FAKE-not-a-real-token",
      sleep: async () => {},
      fetch: async (url, init) => {
        const arg = init?.headers?.["Dropbox-API-Arg"];
        const body = arg ? JSON.parse(arg) : JSON.parse(init.body || "{}");
        const notFound = () =>
          dbxJson(
            {
              error_summary: "path/not_found/..",
              error: { ".tag": "path", path: { ".tag": "not_found" } },
            },
            409
          );
        if (url.includes("/files/upload")) {
          const current = files.get(body.path);
          if (body.mode?.[".tag"] === "update" && current?.rev !== body.mode.update) {
            return dbxJson(
              {
                error_summary: "path/conflict/file/..",
                error: {
                  ".tag": "path",
                  reason: { ".tag": "conflict", conflict: { ".tag": "file" } },
                },
              },
              409
            );
          }
          const rev = `r${(revs += 1)}`;
          files.set(body.path, {
            rev,
            text:
              typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body),
          });
          return dbxJson({ rev });
        }
        if (url.includes("/files/download")) {
          const found = files.get(body.path);
          if (!found) return notFound();
          return new Response(found.text, {
            status: 200,
            headers: { "Dropbox-API-Result": JSON.stringify({ rev: found.rev }) },
          });
        }
        if (url.includes("/files/delete")) {
          if (!files.delete(body.path)) return notFound();
          return dbxJson({});
        }
        return dbxJson({ entries: [], has_more: false });
      },
    });
    const probed = await probeStore(probeFake);
    check(
      "dropbox rev really is a conditional write, and the probe says so",
      probed.ok === true &&
        probed.conditionalWrite.declared === true &&
        probed.conditionalWrite.verified === true &&
        probed.conditionalWrite.rejectsWrong === true &&
        probed.conditionalWrite.acceptsCorrect === true &&
        probed.conditionalWrite.rejectsStale === true &&
        probed.conditionalWrite.mismatch === false
    );
    check("the probe cleans up after itself", probed.cleanedUp === true && files.size === 0);
  }

  {
    // 409 is also how Dropbox says "no such file", so the tag decides, not the
    // status — otherwise an expired token would read as an empty context.
    const store = dropbox(() =>
      dbxJson(
        {
          error_summary: "path/not_found/..",
          error: { ".tag": "path", path: { ".tag": "not_found" } },
        },
        409
      )
    );
    check("a missing object reads as null", (await store.get("gone.md")) === null);
  }

  {
    let threw = null;
    const store = dropbox(() =>
      dbxJson({ error_summary: "expired_access_token/..", error: { ".tag": "expired_access_token" } }, 409)
    );
    try {
      await store.get("a.md");
    } catch (error) {
      threw = error;
    }
    check(
      "a 409 that is not not_found is an error, never mistaken for absence",
      threw !== null
    );
  }

  {
    const body = new TextEncoder().encode("# note").buffer;
    const store = dropbox(
      () =>
        new Response(body, {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "77" }) },
        })
    );
    const object = await store.get("a.md");
    check("a read carries the rev and the bytes", object?.etag === "77");
    check("a read decodes to text", (await object.text()) === "# note");
  }

  {
    // The folder somebody chose is a rootPrefix, exactly as it is for S3, and
    // nothing above the adapter ever sees it.
    const store = dropbox(
      () =>
        dbxJson({
          entries: [
            { ".tag": "file", path_display: "/Context/1-projects/a.md", size: 3, server_modified: "2026-08-01T10:00:00Z" },
            { ".tag": "folder", path_display: "/Context/2-areas" },
          ],
          has_more: false,
        }),
      { rootPrefix: "Context" }
    );
    const page = await store.list({ prefix: "" });
    check(
      "a listing is returned in the caller's own keys, with the folder stripped",
      page.objects[0]?.key === "1-projects/a.md"
    );
    check(
      "dropbox folders become delimitedPrefixes without synthesising anything",
      page.delimitedPrefixes[0] === "2-areas/"
    );
    const arg = JSON.parse(store.fetch.calls[0].body);
    check("a listing is scoped to the chosen folder", arg.path === "/Context");
  }

  {
    // The offline mirror's manifest compares versions without reading every
    // note, which is only possible if a listing carries the same version a
    // read does. On Dropbox that is `rev` — `get` already hands it back as the
    // etag — and the listing dropped it, so every Dropbox note would have
    // looked changed on every sync.
    const store = dropbox(() =>
      dbxJson({
        entries: [
          {
            ".tag": "file",
            path_display: "/1-projects/a.md",
            size: 3,
            server_modified: "2026-08-01T10:00:00Z",
            rev: "0157f8a1",
          },
        ],
        has_more: false,
      })
    );
    const page = await store.list({ prefix: "" });
    check(
      "a dropbox listing carries each file's rev as its etag, the same one a read returns",
      page.objects[0]?.etag === "0157f8a1"
    );
  }

  {
    const store = dropbox(() =>
      dbxJson(
        {
          error_summary: "path/not_found/..",
          error: { ".tag": "path", path: { ".tag": "not_found" } },
        },
        409
      )
    );
    const page = await store.list({ prefix: "" });
    check(
      "a folder that does not exist yet lists empty rather than throwing",
      page.objects.length === 0 && page.truncated === false
    );
  }

  {
    // Many small files is the normal shape of a context sync, so a 429 is an
    // expected condition rather than an outage.
    let calls = 0;
    const waited = [];
    const store = dropbox(
      () => {
        calls += 1;
        return calls === 1
          ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } })
          : dbxJson({ rev: "ok" });
      },
      { sleep: async (ms) => waited.push(ms) }
    );
    const written = await store.put("a.md", "x");
    check("a 429 is retried rather than surfaced", written?.etag === "ok");
    check(
      "the retry honours Dropbox's own Retry-After",
      waited.length === 1 && waited[0] >= 3000
    );
  }

  {
    // A path with an accent or an emoji is a real note name. Dropbox reads its
    // argument out of an HTTP header, so anything non-ASCII has to be escaped
    // rather than refused.
    const store = dropbox(() => dbxJson({ rev: "1" }));
    await store.put("1-projects/café-🌍.md", "x");
    const header = store.fetch.calls[0].headers["Dropbox-API-Arg"];
    check(
      "a non-ASCII key is escaped into the API header rather than rejected",
      /\\u00e9/.test(header) && !/é/.test(header)
    );
  }

  {
    let threw = null;
    const store = dropbox(() => dbxJson({ rev: "1" }));
    try {
      await store.get("../escape.md");
    } catch (error) {
      threw = error;
    }
    check(
      "dropbox refuses a traversing key with the same guard as every other backend",
      threw !== null && /unsafe storage key/.test(threw.message)
    );
  }

}
