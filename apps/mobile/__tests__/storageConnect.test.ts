import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  ADDRESSING_OPTIONS,
  PROVIDERS,
  addressingToForcePathStyle,
  emptyConnectForm,
  forcePathStyleToAddressing,
  hasErrors,
  needsAddressingChoice,
  providerSpec,
  toBindStorageArgs,
  validateConnectForm,
  withProvider,
  type ConnectFormValues,
} from "../features/console/storage/connect";
import {
  addressingIsAmbiguous,
  convexErrorParts,
  describeStorageFailure,
  describeThrownStorageError,
} from "../features/console/storage/errors";

const VALID: ConnectFormValues = {
  provider: "r2",
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-context",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t-example-value",
  rootPrefix: "",
  forcePathStyle: null,
};

describe("validateConnectForm", () => {
  test("a complete form has nothing to say", () => {
    expect(validateConnectForm(VALID)).toEqual({});
    expect(hasErrors({})).toBe(false);
  });

  test("every required field is required", () => {
    const errors = validateConnectForm(emptyConnectForm());
    expect(Object.keys(errors).sort()).toEqual([
      "accessKeyId",
      "bucket",
      "endpoint",
      "secretAccessKey",
    ]);
  });

  test("a bare hostname is caught before a secret goes on the wire", () => {
    expect(validateConnectForm({ ...VALID, endpoint: "s3.example.com" }).endpoint).toContain(
      "full URL",
    );
  });

  test("cleartext is refused, with the reason", () => {
    expect(validateConnectForm({ ...VALID, endpoint: "http://s3.example.com" }).endpoint).toContain(
      "never travel in the clear",
    );
  });

  test("credentials embedded in the URL are refused", () => {
    expect(
      validateConnectForm({ ...VALID, endpoint: "https://key:secret@s3.example.com" }).endpoint,
    ).toContain("Leave the credentials out");
  });

  test("a bucket pasted with a path says where the folder goes instead", () => {
    expect(validateConnectForm({ ...VALID, bucket: "my-context/notes" }).bucket).toContain(
      "root prefix",
    );
  });

  test("a root prefix is optional, but a bad one is not accepted", () => {
    expect(validateConnectForm({ ...VALID, rootPrefix: "" }).rootPrefix).toBe(undefined);
    expect(validateConnectForm({ ...VALID, rootPrefix: "context/" }).rootPrefix).toBe(undefined);
    expect(validateConnectForm({ ...VALID, rootPrefix: "/context" }).rootPrefix).toContain(
      "No leading slash",
    );
    expect(validateConnectForm({ ...VALID, rootPrefix: "a/../../b" }).rootPrefix).toContain("`..`");
  });

  // A secret with a leading space is a legal secret. "Helpfully" trimming it
  // turns a working key into a mysterious auth failure.
  test("whitespace-only is empty, but a secret is never trimmed into validity", () => {
    expect(validateConnectForm({ ...VALID, secretAccessKey: " " }).secretAccessKey).toBe(undefined);
    expect(validateConnectForm({ ...VALID, accessKeyId: "  " }).accessKeyId).toContain("Required");
  });
});

describe("providers", () => {
  test("each provider prefills its own region", () => {
    expect(providerSpec("r2").defaultRegion).toBe("auto");
    expect(providerSpec("s3").defaultRegion).toBe("us-east-1");
  });

  test("switching provider re-prefills a region nobody typed", () => {
    const next = withProvider(emptyConnectForm("r2"), "s3");
    expect(next.region).toBe("us-east-1");
  });

  test("a region someone typed survives switching provider", () => {
    const typed = { ...emptyConnectForm("r2"), region: "eu-central-1" };
    expect(withProvider(typed, "s3").region).toBe("eu-central-1");
  });

  test("providers say up front whether concurrent edits are safe there", () => {
    // CLAUDE.md: degrade honestly, never silently drop conflict detection.
    expect(PROVIDERS.find((p) => p.value === "b2")?.conditionalWrite).toBe("no");
    expect(PROVIDERS.find((p) => p.value === "r2")?.conditionalWrite).toBe("yes");
  });
});

describe("the addressing question", () => {
  /**
   * The point of this whole feature: almost nobody should be asked. Making
   * everyone answer a question about S3 URL styles to connect a bucket is a
   * worse product; asking the handful whose endpoint genuinely cannot be
   * disambiguated is the only question we cannot answer for them.
   */
  test("an ordinary endpoint never raises it", () => {
    expect(needsAddressingChoice(VALID)).toBe(false);
    expect(
      needsAddressingChoice({
        ...VALID,
        endpoint: "https://s3.us-east-1.amazonaws.com",
        bucket: "notes",
      }),
    ).toBe(false);
  });

  test("an endpoint whose first host label is the bucket raises it", () => {
    expect(
      needsAddressingChoice({
        ...VALID,
        endpoint: "https://notes.s3.amazonaws.com",
        bucket: "notes",
      }),
    ).toBe(true);
  });

  /**
   * The coincidence cases from `S3Store`: path-style endpoints whose first
   * label happens to equal the bucket. Guessing "virtual-hosted" here drops the
   * bucket segment and the provider reads the first *key* segment as the
   * bucket — a silent wrong-bucket write.
   */
  test("the coincidence cases raise it too, which is the point", () => {
    expect(
      needsAddressingChoice({ ...VALID, endpoint: "https://s3.wasabisys.com", bucket: "s3" }),
    ).toBe(true);
    expect(
      needsAddressingChoice({
        ...VALID,
        endpoint: "https://abc123.r2.cloudflarestorage.com",
        bucket: "abc123",
      }),
    ).toBe(true);
  });

  test("a bucket that is only a prefix of the label is not ambiguous", () => {
    // "note" vs the label "notes" — `notes.` does not start with `note.`.
    expect(addressingIsAmbiguous("https://notes.s3.amazonaws.com", "note")).toBe(false);
  });

  test("an empty bucket or an unparseable endpoint asks nothing", () => {
    expect(addressingIsAmbiguous("https://s3.example.com", "")).toBe(false);
    expect(addressingIsAmbiguous("not-a-url", "s3")).toBe(false);
  });

  test("the two answers map to forcePathStyle and back", () => {
    expect(ADDRESSING_OPTIONS.map((o) => o.value)).toEqual(["path", "host"]);
    expect(addressingToForcePathStyle("path")).toBe(true);
    expect(addressingToForcePathStyle("host")).toBe(false);
    expect(forcePathStyleToAddressing(true)).toBe("path");
    expect(forcePathStyleToAddressing(false)).toBe("host");
  });

  // `undefined` is the value the backend reads as "nobody answered", and it is
  // what makes it refuse rather than guess. It is not the same as `false`.
  test("nobody having answered is its own value, not 'host'", () => {
    expect(forcePathStyleToAddressing(null)).toBe(null);
    expect(forcePathStyleToAddressing(undefined)).toBe(null);
  });
});

describe("toBindStorageArgs", () => {
  test("trims what is safe to trim and passes the secret through untouched", () => {
    const args = toBindStorageArgs(
      {
        ...VALID,
        endpoint: "  https://abc123.r2.cloudflarestorage.com  ",
        bucket: " my-context ",
        accessKeyId: " AKIAEXAMPLE ",
        secretAccessKey: " keep me ",
      },
      "w1",
    );
    expect(args.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(args.bucket).toBe("my-context");
    expect(args.accessKeyId).toBe("AKIAEXAMPLE");
    expect(args.secretAccessKey).toBe(" keep me ");
  });

  test("an unset root prefix is omitted, not sent as an empty string", () => {
    expect("rootPrefix" in toBindStorageArgs(VALID, "w1")).toBe(false);
    expect(toBindStorageArgs({ ...VALID, rootPrefix: " context/ " }, "w1").rootPrefix).toBe(
      "context/",
    );
  });

  /**
   * The one that matters. `undefined` is what makes the backend refuse an
   * ambiguous endpoint instead of guessing; sending `false` because a toggle
   * happened to start off would be an answer nobody gave — and a wrong guess
   * writes to the wrong bucket.
   */
  test("an unanswered addressing question is omitted, never sent as false", () => {
    expect("forcePathStyle" in toBindStorageArgs(VALID, "w1")).toBe(false);
  });

  test("an answered one is sent exactly as answered", () => {
    expect(toBindStorageArgs({ ...VALID, forcePathStyle: false }, "w1").forcePathStyle).toBe(false);
    expect(toBindStorageArgs({ ...VALID, forcePathStyle: true }, "w1").forcePathStyle).toBe(true);
  });

  test("carries the workspace it was told to bind, not one from the form", () => {
    expect(toBindStorageArgs(VALID, "w9").workspaceId).toBe("w9");
  });
});

describe("describeStorageFailure", () => {
  test("every code in the closed set maps to a fix", () => {
    for (const code of [
      "AMBIGUOUS_ADDRESSING",
      "UNREACHABLE",
      "NOT_WRITABLE",
      "CREDENTIAL_UNAVAILABLE",
      "INVALID_CONFIGURATION",
      "PROBE_FAILED",
    ]) {
      const failure = describeStorageFailure(code, undefined);
      expect(failure.headline.length).toBeGreaterThan(0);
      expect(failure.next).toBeDefined();
    }
  });

  test("only the addressing failure asks for an addressing choice", () => {
    expect(describeStorageFailure("AMBIGUOUS_ADDRESSING", "").needsAddressingChoice).toBe(true);
    expect(describeStorageFailure("UNREACHABLE", "").needsAddressingChoice).toBe(undefined);
  });

  test("the provider's own words survive alongside our sentence", () => {
    const failure = describeStorageFailure("UNREACHABLE", "NoSuchBucket: bucket does not exist");
    expect(failure.next).toContain("endpoint, region, and bucket name");
    expect(failure.detail).toBe("NoSuchBucket: bucket does not exist");
  });

  // An unknown code must not get invented advice. The provider's message is
  // the only honest thing left to show.
  test("an unrecognised code falls back to the provider's message alone", () => {
    const failure = describeStorageFailure("SOMETHING_NEW", "the provider said no");
    expect(failure.detail).toBe("the provider said no");
    expect(failure.next).toBe(undefined);
  });

  test("neither a code nor a message still says something useful", () => {
    const failure = describeStorageFailure(undefined, undefined);
    expect(failure.headline).toBe("Your bucket didn't check out");
    expect(failure.next).toContain("Re-verify");
  });

  test("an empty message counts as no message", () => {
    expect(describeStorageFailure(undefined, "   ").detail).toBe(undefined);
  });
});

describe("convexErrorParts", () => {
  test("reads a ConvexError's code and message", () => {
    const parts = convexErrorParts(
      new ConvexError({ code: "INVALID_ENDPOINT", message: "must use https" }),
    );
    expect(parts).toEqual({ code: "INVALID_ENDPOINT", message: "must use https" });
  });

  test("a string payload is a message with no code", () => {
    expect(convexErrorParts(new ConvexError("plain"))).toEqual({
      code: undefined,
      message: "plain",
    });
  });

  test("an ordinary throw keeps its message", () => {
    expect(convexErrorParts(new Error("socket hang up")).message).toBe("socket hang up");
  });

  test("something that is not an error at all does not explode", () => {
    expect(convexErrorParts(null)).toEqual({ code: undefined, message: undefined });
    expect(convexErrorParts(42)).toEqual({ code: undefined, message: undefined });
  });

  test("describeThrownStorageError joins the two ends up", () => {
    const failure = describeThrownStorageError(
      new ConvexError({ code: "AMBIGUOUS_ADDRESSING", message: "cannot tell" }),
    );
    expect(failure.needsAddressingChoice).toBe(true);
    expect(failure.detail).toBe("cannot tell");
  });
});
