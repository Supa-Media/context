import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * "Done" on Tex's take-over screen (Dev2, 2026-11-12: "it should notify tex
 * so it continues on"). One row per browser: when a person last handed it
 * back. `browser` is a SHA-256 of the gateway's HMAC tag for that browser
 * (`browserOwner`, `groupBrowserOwner`), so it names nobody and only the
 * gateway can make it. The texting Worker that texted the take-over link
 * watches that hash (`apps/agent/src/handbackWatch.ts`) and carries the task
 * on once it moves. Times only, nothing about the page.
 */
export const browserHandbackTables = {
  browserHandbacks: defineTable({
    browser: v.string(),
    doneAt: v.number(),
  }).index("by_browser", ["browser"]),
};
