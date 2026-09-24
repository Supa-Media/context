/// <reference types="vite/client" />

/**
 * A CAPTURE REACHES AN OPEN CONSOLE.
 *
 * The email worker writes the note into the bucket itself, with the credential
 * its ticket bought, and `/gateway/ingest/record` is the only thing the
 * control plane hears afterwards. So that is where the owner's tree is told to
 * walk: without it, mail sent to a personal context sat unseen until the next
 * periodic pass. The owner and nobody else — the path is not sent there (and
 * must not be), so no other audience can be judged, and an under-reported
 * change arrives late where an over-reported one would date it.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { asUser, ingestPost } from "../fixtures.helpers";
import { RECORD, ready, resolvedTicket } from "./fixtures.helpers";

describe("a capture reaches an open console", () => {
  test("a captured message moves the owner's hint, and no other audience", async () => {
    const { t, ownerId, workspaceId } = await ready();
    const hint = () =>
      asUser(t, ownerId).query(api.functions.treeSignals.treeSignal, { workspaceId });
    expect(await hint()).toBeNull();

    await ingestPost(t, RECORD, { ticket: await resolvedTicket(t, "seyi"), outcome: "captured", bytes: 1 });

    expect(await hint()).not.toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("treeSignals").collect());
    expect(rows.map((row) => [row.workspaceId, row.audience])).toEqual([[workspaceId, "private"]]);
  });

  test("a duplicate and an invented ticket move nothing", async () => {
    const { t } = await ready();
    await ingestPost(t, RECORD, { ticket: await resolvedTicket(t, "seyi"), outcome: "duplicate", bytes: 1 });
    await ingestPost(t, RECORD, { ticket: "not-a-ticket", outcome: "captured", bytes: 1 });
    expect(await t.run((ctx) => ctx.db.query("treeSignals").collect())).toEqual([]);
  });
});
