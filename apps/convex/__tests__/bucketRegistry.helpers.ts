/**
 * The buckets a test's fetch stub is serving, by name, so a fixture can read the
 * `privacy.md` a test seeded into one (`seededRules.helpers.ts`). Test-only:
 * `memoryS3` registers itself here and nothing in `functions/` reads it.
 */

export interface RulesSource {
  text(): Promise<string | null>;
  remove(): Promise<void>;
}

export interface BucketView {
  rulesSource(key: string): RulesSource;
}

const buckets = new Map<string, BucketView>();

export function registerBucket(name: string, view: BucketView): void {
  buckets.set(name, view);
}

export function bucketView(name: string): BucketView | undefined {
  return buckets.get(name);
}
