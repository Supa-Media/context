/**
 * The person's own Tex history file, shared with someone by name, opens for them (Dev2, 2026-11-10: a history file
 * @shyoh shared showed in Shared with me and said "This note isn't shared with you any more" when opened).
 *
 * The history file is the one non-Markdown file a row may be shared by (`takesOwnVisibility`), so the grant read
 * takes it too: read only, with the ledger's JSON whole, and titled "Tex history" in the list. Any other file that is
 * not Markdown is still refused, and a group chat's history file is never the personal one.
 *
 * Sabotage: put back `.endsWith(".md")` in `readGrantedNoteHandler` and "a granted history file reads" fails; drop
 * `!history` from its `canEdit` and "never writable" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { captureError, errorCode, asUser } from "../fixtures.helpers";
import { grantUser, noteIdOf, readByNoteId, readByPath, setListFor, world } from "./outsider.helpers";
import { fallbackTitle } from "../../functions/lib/shares/grantedInbox";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => vi.unstubAllGlobals());

const HISTORY = "tex/history.ledger.json";
const OTHER_JSON = "tex/data.json";
// A body with what a Markdown comment looks like inside it: a read only view keeps the ledger exactly as it is.
const LEDGER = `${JSON.stringify({ manifest: null, view: { shown: 1, older: false }, entries: [{ id: "e1", at: 1, kind: "text", text: "zzq-history-marker <!-- c1 -->" }] }, null, 2)}\n`;

describe("a Tex history file shared by name", () => {
  test("a granted history file reads, whole and read only", async () => {
    const w = await world({ [HISTORY]: LEDGER });
    await grantUser(w, HISTORY, w.kola);

    const byId = await readByNoteId(w, w.kola, await noteIdOf(w, HISTORY));
    expect(byId.path).toBe(HISTORY);
    expect(byId.text).toBe(LEDGER);
    expect(byId.canEdit).toBe(false);
    expect(byId.etag).toBeNull();

    const byPath = await readByPath(w, w.kola, HISTORY);
    expect(byPath.text).toBe(LEDGER);
  });

  test("never writable through the grant, even an edit grant", async () => {
    const w = await world({ [HISTORY]: LEDGER });
    await setListFor(w, HISTORY, [{ kind: "user", userId: w.kola, role: "edit" }]);

    const read = await readByPath(w, w.kola, HISTORY);
    expect(read.canEdit).toBe(false);
    const error = await captureError(() =>
      asUser(w.t, w.kola).action(api.functions.shares.writeGrantedNote, { workspaceId: w.ws, path: HISTORY, text: "{}", expectedEtag: "x" }),
    );
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("an ungranted history file is refused as every other refusal is", async () => {
    const w = await world({ [HISTORY]: LEDGER });
    expect(errorCode(await captureError(() => readByPath(w, w.kola, HISTORY)))).toBe("SHARE_UNAVAILABLE");
  });

  test("any other file that is not Markdown is still refused", async () => {
    const w = await world({ [OTHER_JSON]: "{}" });
    expect(errorCode(await captureError(() => readByPath(w, w.kola, OTHER_JSON)))).toBe("SHARE_UNAVAILABLE");
  });

  test("the list calls it Tex history, never its file name", () => {
    expect(fallbackTitle(HISTORY, "file")).toBe("Tex history");
    expect(fallbackTitle("tex/groups/blue-fox/history.ledger.json", "file")).toBe("history.ledger.json");
    expect(fallbackTitle("1-projects/plan.md", "file")).toBe("plan");
  });
});
