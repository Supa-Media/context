/** The share-link tools (`create_link`, `list_links`, `revoke_link`) and sharing a note on write. Moved verbatim out of `src/index.js`. */

import { normalizePath } from "../notes/paths.js";
import { toolError, toolText } from "./results.js";

/**
 * `write_note`'s `share`, and why publishing lives on the write tool at all.
 *
 * ## A new ARGUMENT reaches a client that a new TOOL cannot
 *
 * `create_link` and `create_form` are tools, and a tool is only callable once
 * the client has re-fetched `tools/list`. Clients cache that listing and
 * refresh on their own schedule — some not for a long time — so for them those
 * two names simply do not exist, and no prose makes an absent tool callable.
 *
 * An argument is different. `toolArgumentRefusal` validates against the schema
 * **this server advertises now**, never against the client's copy, so a client
 * may pass `share` before it has ever seen it advertised — it only has to be
 * told the argument exists, which `orient` and this tool's own description do.
 * `write_note` is in every client's list and has been from the beginning.
 *
 * That is the whole reason this is here rather than only in `create_link`:
 * the two halves of "make me a form and publish it" have to be reachable
 * through a tool nobody's cache can be missing.
 *
 * ## The note is never lost to a refused link
 *
 * Minting is the owner's and writing is an editor's, so an editor who asks for
 * both gets the write and a refusal for the link. Returning an error would
 * throw away a note that was correctly written and already stored — the caller
 * would have no way to tell "nothing happened" from "everything happened but
 * the link", and the honest answer is both outcomes, named.
 *
 * ## Three words, mapped to two axes in one place
 *
 * A share row has an audience and a mode, and `create_link` keeps them apart
 * because they are genuinely different questions. Here one enum of three plain
 * words is what an agent can use without reading a schema it may not have, and
 * `collect` expands to the pair in exactly this function.
 */
export async function shareWrittenNote(store, path, args) {
  const want = args.share;
  if (want !== "members" && want !== "anyone" && want !== "collect") return [];

  const calls = store?.links;
  if (!calls) {
    return ["the note was written; links are not available on this deployment, so none was minted."];
  }

  const minted = await mintAndDescribe(calls, {
    path,
    audience: want === "members" ? "members" : "anyone",
    // Stated rather than defaulted: `write_note` writes a note, so a link over
    // it is always a note link. A folder cannot arrive here at all.
    kind: "note",
    ...(want === "collect" ? { mode: "collect" } : {}),
    ...(typeof args.share_short === "string" ? { short: args.share_short } : {}),
  });
  if (!minted.ok) return [`the note was written, but ${minted.error}`];
  return minted.lines;
}

/* ---------------------------------- links --------------------------------- */

/**
 * Minting, listing and revoking a link, from an agent.
 *
 * ## Why these exist at all
 *
 * The console has had share links since the beginning and nothing in the MCP
 * surface could mint one — so an agent asked for "a link to send them" had two
 * options, both wrong: tell the person to go and find the console, or write a
 * URL out of the path it was holding. The second is the one that actually
 * happened, and a guessed URL is worse than no URL: it looks right, it gets
 * pasted, and it opens nothing.
 *
 * ## The gateway builds nothing
 *
 * Every one of these hands back what the control plane returned. The URL is
 * built there, from the same `@context/shared` function the console's Copy
 * link uses, because the only thing worse than one guessed URL is two
 * builders disagreeing about the real one. Where a deployment has not set
 * `APP_ORIGIN` the control plane says so with a path and no URL, and the
 * refusal below says that rather than inventing an origin.
 *
 * ## One refusal
 *
 * The control plane answers `null` for a caller who is not an owner, a path
 * that is not a note, a note that is not team-visible, and an encrypted one.
 * Nothing here unpicks that: an agent that could tell "not yours" from "not
 * there" would be an oracle over somebody else's context, and the console's
 * own dialog is where an owner gets the specific reason.
 */
export async function toolCreateLink(store, scope, args) {
  const calls = store?.links;
  if (!calls) return toolError("links are not available on this deployment.");

  const path = normalizePath(args.path);
  if (!path) return toolError("path must be a note or folder path in this context");

  const minted = await mintAndDescribe(calls, {
    path,
    audience: args.audience === "members" ? "members" : "anyone",
    ...(args.kind === undefined ? {} : { kind: args.kind }),
    ...(typeof args.short === "string" ? { short: args.short } : {}),
    ...(typeof args.title_in_preview === "boolean"
      ? { titleInPreview: args.title_in_preview }
      : {}),
    ...(args.mode === "collect" ? { mode: "collect" } : {}),
    ...(typeof args.collect_cap === "number" ? { collectCap: args.collect_cap } : {}),
  });
  return minted.ok ? toolText(minted.lines.join("\n")) : toolError(minted.error);
}

/**
 * Mint one link and say what it hands out. Shared by `create_link` and by
 * `write_note`'s `share`.
 *
 * Factored the moment there were two callers, and the reason is the sentences
 * rather than the request: **what an owner is told about a link is part of
 * what the link is.** A second caller that minted the same row and printed its
 * own shorter summary would be publishing a write endpoint on somebody's
 * behalf while saying less about it than the first caller does.
 *
 * Answers `{ ok: false, error }` rather than a tool result, because one caller
 * refuses the whole call on a failed mint and the other has already written a
 * note and must report the refusal beside it.
 */
async function mintAndDescribe(calls, request) {
  const result = await calls.create(request);
  if (result !== null && typeof result.refused === "string") {
    return { ok: false, error: `the link was refused: ${result.refused}` };
  }
  if (result === null) {
    return {
      ok: false,
      error:
        "that link cannot be minted. Minting is the context owner's, the path has to be a note " +
        "or folder the workspace can already read, and an encrypted note is never linkable.",
    };
  }

  const { link, shortRefused } = result;
  const lines = [describeLink(link)];
  if (shortRefused !== null) {
    lines.push(`the short name was not claimed: ${shortRefused}`);
    lines.push("The link above works; ask them for another name if they want a short one.");
  }
  if (link.audience === "anyone") {
    lines.push(
      link.shortUrl === null
        ? "Anyone holding this link can open it without an account."
        : "Anyone holding this link can open it without an account — and a short name is " +
            "guessable by anyone who types it, which is what makes it worth having and is not " +
            "true of the long link."
    );
  }
  /*
    Said on the mint, not left to the agent's memory of the schema.

    A collect link is the only thing in this product a stranger can WRITE
    through, and the three facts below are the ones an owner has to hear before
    they paste it anywhere: answers arrive from people nobody can name, nobody
    can read the answers through it, and there is a ceiling. An agent that
    pastes a URL without saying so has published a write endpoint on somebody's
    behalf and told them it was a link.
  */
  if (link.collecting) {
    lines.push(
      "This link TAKES ANSWERS. Tell them, in your own words, all three: anyone holding it can " +
        "send an answer to the form without an account and without being named; nobody can read " +
        "the answers through it, so an answer is final once sent; and it stops on its own at " +
        `${link.collectCap ?? "its"} answers, which collect_cap changes.`
    );
  }
  return { ok: true, lines };
}

export async function toolListLinks(store, scope) {
  const calls = store?.links;
  if (!calls) return toolError("links are not available on this deployment.");

  const links = await calls.list();
  if (links === null) return toolError("listing this context's links is the owner's.");
  if (links.length === 0) return toolText("no live links in this context.");
  return toolText(links.map((link) => describeLink(link)).join("\n\n"));
}

export async function toolRevokeLink(store, scope, args) {
  const calls = store?.links;
  if (!calls) return toolError("links are not available on this deployment.");

  const shareId = typeof args.share_id === "string" ? args.share_id.trim() : "";
  if (!shareId) return toolError("share_id is required; list_links reports it");

  const revoked = await calls.revoke(shareId);
  // One refusal covers "not yours", "already revoked" and "no such id" — the
  // same three the console's own revoke refuses as one, for the same reason.
  if (!revoked) return toolError("no live link with that id in this context.");
  return toolText(
    "revoked. That link no longer opens anything, and its short name is free again.\n" +
      "A preview card that already unfurled somewhere is cached by whatever unfurled it and " +
      "cannot be recalled; the link itself is dead immediately."
  );
}

/** One link, as an agent reads it. The URL first, because that is the answer. */
function describeLink(link) {
  const lines = [
    link.url === null
      ? `link: ${link.path} (this deployment has not set its public origin, so prefix your own)`
      : `link: ${link.url}`,
  ];
  if (link.shortUrl !== null) lines.push(`short link: ${link.shortUrl}`);
  lines.push(`opens: ${link.entryPath}`);
  lines.push(
    `audience: ${
      link.audience === "anyone"
        ? "anyone with the link, no account needed"
        : link.audience === "members"
          ? "members of this context"
          : link.audience
    }`
  );
  if (link.collecting) {
    lines.push(
      `taking answers: yes — a form on this note, from anyone (${link.collected ?? 0} of ` +
        `${link.collectCap ?? "?"} so far)`
    );
  }
  lines.push(`id: ${link.shareId}`);
  return lines.join("\n");
}
