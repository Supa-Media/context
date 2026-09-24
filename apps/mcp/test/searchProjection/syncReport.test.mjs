/**
 * What the R2 sync tells the projection about the notes it just moved:
 * `syncShardedIndex`'s own touched/removed report, checked against what the
 * projection actually indexed.
 *
 * Split out of searchProjection.test.mjs; see fixtures.mjs for the shared D1
 * backend stub and constants.
 */

import { createS3Backend, createSearchBudget, storeForBinding, syncShardedIndex } from "./fixtures.mjs";

const SYNC_ENDPOINT = "https://s3.example-syncreport.test";

export async function runSyncReportChecks(check) {
  const s3 = createS3Backend(SYNC_ENDPOINT);
  const restore = s3.install();
  try {
    const bucket = s3.bucketFor("sync-report-bucket");
    bucket.set("1-projects/one.md", { body: "# One\n\nalpha\n", etag: "s1" });
    bucket.set("1-projects/two.md", { body: "# Two\n\nbeta\n", etag: "s2" });
    bucket.set("index.md", { body: "# Index\n\ngamma\n", etag: "s3" });

    const store = storeForBinding(
      {
        provider: "s3",
        endpoint: SYNC_ENDPOINT,
        region: "auto",
        bucket: "sync-report-bucket",
        accessKeyId: "AKIAEXAMPLEEXAMPLESYN",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLESYN",
        forcePathStyle: true,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      },
      {},
    );

    const first = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check(
      "a sync names every note it indexed",
      [...first.touched].sort().join(",") ===
        "1-projects/one.md,1-projects/two.md,index.md",
    );
    check("and has removed nothing", first.removed.length === 0);

    const settled = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check(
      "a converged sync names nothing, so the projection re-copies nothing",
      settled.touched.length === 0 && settled.removed.length === 0,
    );

    bucket.delete("1-projects/two.md");
    bucket.set("index.md", { body: "# Index\n\ngamma and delta\n", etag: "s4" });
    const moved = await syncShardedIndex(store, { budget: createSearchBudget(200) });
    check("an edited note is named as touched", moved.touched.join(",") === "index.md");
    check("and a deleted one as removed", moved.removed.join(",") === "1-projects/two.md");
  } finally {
    restore();
  }
}
