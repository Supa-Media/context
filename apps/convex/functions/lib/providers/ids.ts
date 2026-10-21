/**
 * Every connector provider's id, the one list the schema, the registry, the
 * gateway and the app's `/connect/<provider>` pages agree on
 * (`docs/decisions/connectors.md`). Dependency-free so the app can import it.
 */

import { v } from "convex/values";

export const PROVIDER_IDS = [
  "slack",
  "microsoft",
  "planning-center",
  "linear",
  "notion",
  "atlassian",
  "airtable",
  "calendly",
  "monday",
  "clickup",
  "todoist",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The schema's and every function's validator for a provider id; kept equal to `PROVIDER_IDS` by its type. */
export const providerValidator = v.union(
  v.literal("slack"),
  v.literal("microsoft"),
  v.literal("planning-center"),
  v.literal("linear"),
  v.literal("notion"),
  v.literal("atlassian"),
  v.literal("airtable"),
  v.literal("calendly"),
  v.literal("monday"),
  v.literal("clickup"),
  v.literal("todoist"),
);

// A provider missing from either list fails the type check here.
type ValidatorIds = typeof providerValidator.type;
const _sameIds: [ValidatorIds, ProviderId] extends [ProviderId, ValidatorIds] ? true : never = true;
void _sameIds;
