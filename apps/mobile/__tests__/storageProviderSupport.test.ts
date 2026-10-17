import { describe, expect, test } from "@jest/globals";
import { PROVIDERS, isSupportedProvider } from "../features/console/storage/connect";
import { describeStorageFailure } from "../features/console/storage/errors";
import { storagePillLabel } from "../features/console/storage/pill";

/**
 * A binding can still name a provider this build no longer runs, until its
 * cleanup lands. Every switch on provider must answer "not supported" for it
 * rather than crash or invent a credential shape the binding does not have.
 */
describe("isSupportedProvider", () => {
  test("every provider the connect form offers is supported", () => {
    for (const provider of PROVIDERS) {
      expect(isSupportedProvider(provider.value)).toBe(true);
    }
  });

  test("a provider this build no longer runs is not supported", () => {
    expect(isSupportedProvider("retired-provider")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
  });
});

describe("a retired provider on the storage surfaces", () => {
  test("a failure on it is described as a bucket failure, never as a credential it lacks", () => {
    const failure = describeStorageFailure("CREDENTIAL_UNAVAILABLE", undefined);
    expect(failure.headline).toBe("We can't open the stored credential any more");
    expect(failure.next).toContain("Paste the access key and secret again");
  });

  test("the pill label still prints, and never the word undefined", () => {
    expect(storagePillLabel({ provider: "retired-provider" })).toBe("retired-provider");
  });
});
