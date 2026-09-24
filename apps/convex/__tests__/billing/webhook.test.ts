import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  setupTest,
} from "../fixtures.helpers";
import {
  SIGNING_SECRET,
  context,
  chooseBoth,
  signed,
  postWebhook,
  checkoutCompleted,
  subscriptionEvent,
} from "./fixtures.helpers";

describe("the webhook", () => {
  test("an unsigned delivery buys nothing", async () => {
    // THE TEST THIS FILE EXISTS FOR. An unsigned webhook that sets an
    // entitlement is a free upgrade for anybody who can POST.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unsigned");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );

      for (const header of [null, "", "garbage", `t=1,v1=${"a".repeat(64)}`]) {
        const response = await postWebhook(t, checkoutCompleted(sessionId), {
          header,
        });
        expect(response.status).toBe(401);
      }
      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan?.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a delivery signed with somebody else's secret buys nothing either", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "wrongsecret");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId), {
        secret: "whsec_a_different_fake_secret",
      });
      expect(response.status).toBe(401);
      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan?.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a deployment with no signing secret refuses every delivery", async () => {
    // Not "allows". `vitest.config.ts` sets no signing secret, so this is the
    // default state of the whole suite and of a self-hoster's deployment.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "nosecret");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    const response = await postWebhook(t, checkoutCompleted(sessionId));
    expect(response.status).toBe(401);
  });

  test("a signed completed checkout turns the plan on", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "quay");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      // Existing free/BYO contexts are the migration journey. Payment must
      // schedule managed provisioning even though a binding already exists;
      // the provisioner copies it instead of overwriting it.
      await t.run((ctx) =>
        ctx.db.insert("storageBindings", {
          workspaceId,
          provider: "s3",
          endpoint: "https://s3.example.invalid",
          region: "us-east-1",
          bucket: "existing-bucket",
          accessKeyId: "existing-key",
          encryptedSecretAccessKey: "sealed-existing",
          status: "connected",
          capabilities: { conditionalWrite: true },
          boundBy: owner,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId));
      expect(response.status).toBe(200);

      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("active");
      expect(view.active).toEqual({ managedStorage: true, fastSearch: true });
      expect(view.hasStripeCustomer).toBe(true);
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(
        scheduled.filter((job) => job.name.includes("syncPremiumSelection")),
      ).toHaveLength(1);
      expect(
        scheduled.filter((job) => job.name.includes("provisionManagedStorage")),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the workspace comes off our row, never out of the event", async () => {
    /*
      The event carries `metadata.workspaceId` for an operator reading the
      Stripe dashboard. If anything here resolved from it, a signed event
      naming another tenant's workspace would upgrade that tenant — and during
      a signing-secret leak that is a cross-tenant write. So the reference is
      OUR session row, and a bogus one resolves to nothing.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const victim = await context(t, "victim");
      await chooseBoth(t, victim.owner, victim.workspaceId);
      const attacker = await context(t, "attacker");
      await chooseBoth(t, attacker.owner, attacker.workspaceId);
      const { sessionId } = await asUser(t, attacker.owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId: attacker.workspaceId },
      );

      // The attacker's own session, with the victim's workspace named all over
      // the metadata. Only the attacker's context may move.
      const event = checkoutCompleted(sessionId, {
        metadata: { workspaceId: victim.workspaceId },
      });
      (event.data.object as Record<string, unknown>).workspaceId = victim.workspaceId;
      expect((await postWebhook(t, event)).status).toBe(200);

      const victimView = await asUser(t, victim.owner).query(
        api.functions.billing.status,
        { workspaceId: victim.workspaceId },
      );
      expect(victimView.status).toBe("none");
      const attackerView = await asUser(t, attacker.owner).query(
        api.functions.billing.status,
        { workspaceId: attacker.workspaceId },
      );
      expect(attackerView.status).toBe("active");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a reference to no row of ours changes nothing, and is not retried", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "noref");
      await chooseBoth(t, owner, workspaceId);
      // 200, deliberately: a non-2xx tells Stripe to retry, and retrying will
      // not make this row exist.
      const response = await postWebhook(t, checkoutCompleted("not-an-id"));
      expect(response.status).toBe(200);
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a redelivery of the same event is a no-op", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "redelivered");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      const first = await t.run((ctx) => ctx.db.query("workspacePlans").unique());

      await postWebhook(t, checkoutCompleted(sessionId));
      const second = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      /*
        What "no-op" means here, stated as the fields the event writes rather
        than as `updatedAt`.

        It was `updatedAt`, which was a fair proxy while this event was the
        only thing that ever touched the row — and stopped being one when a
        paid plan started scheduling its own bucket, because recording where
        *that* got to is a legitimate later write to the same row. Asserting
        the applied event's own fields is both narrower and stronger: a second
        application would move the status, the event id and the audit trail,
        and none of them moves.
      */
      expect(second!.status).toBe(first!.status);
      expect(second!.lastEventIds).toEqual(first!.lastEventIds);
      expect(second!.lastEventAt).toBe(first!.lastEventAt);
      expect(second!.stripeSubscriptionId).toBe(first!.stripeSubscriptionId);
      // And no second audit row claiming the plan changed twice.
      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(audit.filter((row) => row.action === "billing.plan_updated")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an older event arriving after a newer one does not undo it", async () => {
    /*
      Delivery is at-least-once and out of order. Without the timestamp check,
      a retried `subscription.updated` from before a cancellation quietly
      re-activates a cancelled plan — which is the failure that is invisible
      until somebody notices they are still being served after cancelling.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "outoforder");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_500,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");

      // The stale retry, created before the cancellation.
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_stale",
          created: 1_780_000_200,
          status: "active",
        }),
      );
      const after = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(after.status).toBe("canceled");
      expect(after.active).toEqual({ managedStorage: false, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a cancellation is not undone by a retry stamped in the same second", async () => {
    /*
      THE ONE THE STRICT COMPARISON LET THROUGH.

      Two decisions cancelled each other out at a second boundary — which is
      exactly where Stripe stamps a cancellation pair, because `updated` and
      `deleted` are emitted together. `lastEventId` remembered ONE id, and the
      ordering check was strict `<`, so an event created in the same second as
      the last one applied was neither a duplicate nor out of order:

        evt_upd (T, active)  → applied.  lastEventId = evt_upd
        evt_del (T, deleted) → applied.  lastEventId = evt_del, plan canceled
        evt_upd (T) retried  → id differs, and T < T is false → APPLIED
                             → plan active again, both entitlements restored.

      Delivery is at-least-once and a retry is freshly signed, so the
      signature's five-minute tolerance does not bound this: it can arrive at
      any point in Stripe's retry schedule, days later, and it re-activates a
      subscription somebody cancelled.

      `<=` is not the fix — it drops the legitimate `deleted` when `updated`
      arrives first in the same second, which is the ordinary ordering. The fix
      is to remember every id applied *at* `lastEventAt`.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "resurrection");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      // The pair Stripe emits together, both stamped in the same second.
      const sameSecond = 1_780_000_500;
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_upd", created: sameSecond, status: "active" }),
      );
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_del",
          type: "customer.subscription.deleted",
          created: sameSecond,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");

      // Stripe retries the earlier one. It must change nothing.
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_upd", created: sameSecond, status: "active" }),
      );
      const after = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(after.status).toBe("canceled");
      expect(after.active).toEqual({ managedStorage: false, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("...and the legitimate second half of that pair is still applied", async () => {
    /*
      The direction `<=` would have broken, and the reason the fix is a set of
      ids rather than a wider comparison. `updated` then `deleted` in one second
      is the ORDINARY ordering, and the cancellation must land.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "same-second-pair");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      const sameSecond = 1_780_000_500;
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_a", created: sameSecond, status: "active" }),
      );
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_b",
          type: "customer.subscription.deleted",
          created: sameSecond,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a retry from an older second is still dropped, and does not clear the set", async () => {
    // The half that already worked, kept: remembering ids *at* `lastEventAt`
    // must not weaken the ordering check that covers everything before it.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "older-second");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_900,
          status: "canceled",
        }),
      );
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_old", created: 1_780_000_200, status: "active" }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");
      // …and a retry of the id that IS at the current second is still caught,
      // which is what a naive "reset the set on every apply" would break.
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_900,
          status: "canceled",
        }),
      );
      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(
        audit.filter((row) => row.action === "billing.plan_updated"),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a lapse loses the entitlements and keeps the choice", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "lapsed");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_pastdue", created: 1_780_001_000, status: "past_due" }),
      );

      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("past_due");
      expect(view.active).toEqual({ managedStorage: false, fastSearch: false });
      // Resuming is a payment, not a re-selection.
      expect(view.selected).toEqual({ managedStorage: true, fastSearch: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a plan never activates entitling nothing, even if the selection was emptied", async () => {
    /*
      The belt to the refusal's braces, for the race the refusal cannot catch —
      two tabs, or a mutation landing between the press and the webhook. What a
      person paid for is what they chose **at checkout**, so that selection is
      snapshotted on the attempt row and restored if the live one is empty when
      the plan activates. Nobody ends up paying $5 for nothing.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "emptied-mid-flight");
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      });
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      // Straight to the row, because the mutation now refuses this — the point
      // is that the webhook is safe even if the state is reached some other way.
      await t.run(async (ctx) => {
        const plan = await ctx.db.query("workspacePlans").unique();
        await ctx.db.patch(plan!._id, { managedStorage: false, fastSearch: false });
      });

      await postWebhook(t, checkoutCompleted(sessionId));
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("active");
      expect(view.active).toEqual({ managedStorage: true, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the snapshot follows the choice while the attempt is live", async () => {
    /*
      Found reading my own fix rather than by the review.

      A live attempt is reused rather than joined by a second one, so the
      snapshot was whatever had been chosen at the FIRST press. Change the
      selection afterwards — allowed, as long as it is not emptied — and the
      snapshot names something the owner has since changed their mind about. If
      the restore then fires, it restores the wrong one, which is worse than
      restoring the right one.

      So the snapshot tracks the selection for as long as the attempt is live:
      it means "the last thing they chose while this was open", not "the first".
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "changed-mind");
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      });
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      // Second thoughts, while the attempt is still open.
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: false,
        fastSearch: true,
      });
      const row = await t.run((ctx) => ctx.db.get(sessionId));
      expect(row?.selectedAtCheckout).toEqual({
        managedStorage: false,
        fastSearch: true,
      });

      // And if the restore fires, it restores the newer choice.
      await t.run(async (ctx) => {
        const plan = await ctx.db.query("workspacePlans").unique();
        await ctx.db.patch(plan!._id, { managedStorage: false, fastSearch: false });
      });
      await postWebhook(t, checkoutCompleted(sessionId));
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.active).toEqual({ managedStorage: false, fastSearch: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a checkout that completed without being paid for turns nothing on", async () => {
    // Stripe's `payment_status` can be `unpaid` on a completed session — a
    // bank-debit method that has not cleared, among others. A session is
    // judged on its own vocabulary, never on a subscription's.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unpaid");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(
        t,
        checkoutCompleted(sessionId, { payment_status: "unpaid" }),
      );
      expect(response.status).toBe(200);
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a type nobody handles is accepted and ignored", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unhandled");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, {
        ...checkoutCompleted(sessionId),
        type: "invoice.payment_failed",
      });
      // 200: retrying will not make us handle it.
      expect(response.status).toBe(200);
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a signed body that is not an event at all is a bad request", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      expect((await postWebhook(t, { hello: "world" })).status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the response says nothing about which context or subscription", async () => {
    // The caller is Stripe and does not need it, and during a signing-secret
    // leak this endpoint is reachable by more people than we would like.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "quiet");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId));
      const text = await response.text();
      expect(text).not.toContain(String(workspaceId));
      expect(text).not.toContain("sub_FAKE");
      expect(text).not.toContain("cus_FAKE");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

