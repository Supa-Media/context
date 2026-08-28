import { addressingIsAmbiguous } from "./errors";

/**
 * The connect-your-bucket form, as data.
 *
 * All of it is here rather than in the component so the awkward parts — which
 * endpoint is acceptable, when the addressing question is worth asking, what
 * actually gets sent — are pinned by tests instead of by clicking through a
 * form with a real credential in it.
 */

export type Provider = "r2" | "s3" | "b2" | "s3-compatible";

export interface ProviderSpec {
  value: Provider;
  label: string;
  /** One line: what this is, and the one thing people get wrong about it. */
  detail: string;
  endpointPlaceholder: string;
  /** Prefilled, because it is the same for everyone on this provider. */
  defaultRegion: string;
  regionHint?: string;
  /**
   * Whether conditional writes are reliable here. Shown *before* connecting,
   * because "this provider cannot detect a concurrent edit" is worth knowing
   * while choosing, not after. The real answer still comes from the probe.
   */
  conditionalWrite: "yes" | "no";
}

export const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  {
    value: "r2",
    label: "Cloudflare R2",
    detail: "No egress fees. Conditional writes work, so concurrent edits are safe.",
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    defaultRegion: "auto",
    regionHint: "R2 uses `auto`.",
    conditionalWrite: "yes",
  },
  {
    value: "s3",
    label: "Amazon S3",
    detail: "Conditional writes work. Turn on bucket versioning for point-in-time recovery.",
    endpointPlaceholder: "https://s3.us-east-1.amazonaws.com",
    defaultRegion: "us-east-1",
    conditionalWrite: "yes",
  },
  {
    value: "b2",
    label: "Backblaze B2",
    detail: "Works, but cannot detect a concurrent edit — two clients writing the same note at once can lose one.",
    endpointPlaceholder: "https://s3.us-west-004.backblazeb2.com",
    defaultRegion: "us-west-004",
    conditionalWrite: "no",
  },
  {
    value: "s3-compatible",
    label: "Anything S3-compatible",
    detail: "Wasabi, MinIO, Storj, your own. We check what it actually supports rather than assuming.",
    endpointPlaceholder: "https://s3.example.com",
    defaultRegion: "us-east-1",
    conditionalWrite: "no",
  },
];

export function providerSpec(provider: Provider): ProviderSpec {
  return PROVIDERS.find((entry) => entry.value === provider) ?? PROVIDERS[3];
}

export interface ConnectFormValues {
  provider: Provider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  rootPrefix: string;
  /**
   * `null` means "let the adapter decide", which is the right answer almost
   * always. It becomes a real choice only when the endpoint and bucket cannot
   * be told apart — see `addressingIsAmbiguous`.
   */
  forcePathStyle: boolean | null;
}

export function emptyConnectForm(provider: Provider = "r2"): ConnectFormValues {
  return {
    provider,
    endpoint: "",
    region: providerSpec(provider).defaultRegion,
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    rootPrefix: "",
    forcePathStyle: null,
  };
}

/**
 * Switching provider re-prefills the region, but only while the region is still
 * whatever the last provider prefilled. A region someone typed is theirs.
 */
export function withProvider(
  values: ConnectFormValues,
  provider: Provider,
): ConnectFormValues {
  const wasDefault = values.region === providerSpec(values.provider).defaultRegion;
  return {
    ...values,
    provider,
    region: wasDefault ? providerSpec(provider).defaultRegion : values.region,
  };
}

export type ConnectField = "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey" | "rootPrefix";

export type ConnectErrors = Partial<Record<ConnectField, string>>;

/**
 * Client-side validation.
 *
 * Deliberately a subset of what `bindStorage` enforces, and never a substitute
 * for it: the SSRF host filter, the credential rules, and the addressing
 * refusal all live on the server and stay there. What this buys is that the
 * three mistakes people actually make — a bare hostname, an `s3://` URL, a
 * bucket pasted with a trailing slash — are caught before a secret is put on
 * the wire.
 */
export function validateConnectForm(values: ConnectFormValues): ConnectErrors {
  const errors: ConnectErrors = {};

  const endpoint = values.endpoint.trim();
  if (endpoint.length === 0) {
    errors.endpoint = "Required.";
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(endpoint);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      errors.endpoint = "Needs to be a full URL, starting with https://";
    } else if (parsed.protocol !== "https:") {
      errors.endpoint = "Has to be https — a credential must never travel in the clear.";
    } else if (parsed.username !== "" || parsed.password !== "") {
      errors.endpoint = "Leave the credentials out of the URL; they go in the fields below.";
    }
  }

  if (values.region.trim().length === 0) {
    errors.region = "Required. Use `auto` if your provider doesn't have regions.";
  }

  const bucket = values.bucket.trim();
  if (bucket.length === 0) {
    errors.bucket = "Required.";
  } else if (bucket.includes("/")) {
    errors.bucket = "Just the bucket name. A folder inside it goes in the root prefix below.";
  }

  if (values.accessKeyId.trim().length === 0) errors.accessKeyId = "Required.";
  if (values.secretAccessKey.length === 0) errors.secretAccessKey = "Required.";

  const prefix = validateRootPrefix(values.rootPrefix);
  if (prefix !== undefined) errors.rootPrefix = prefix;

  return errors;
}

/**
 * A root prefix, checked. `undefined` means there is nothing wrong with it —
 * including when it is empty, because a root prefix is always optional.
 *
 * Its own function because the Dropbox card asks the same question with
 * different words: `CLAUDE.md` permits a root prefix **the customer chose**
 * and forbids us deriving one, so both surfaces have to accept a typed folder
 * and both have to refuse the same shapes. Two copies of "no leading slash, no
 * `..`" is two chances for one of them to drift into accepting a traversal.
 */
export function validateRootPrefix(value: string, container = "bucket"): string | undefined {
  const prefix = value.trim();
  if (prefix.length === 0) return undefined;
  if (prefix.startsWith("/")) {
    return `No leading slash — it's a folder inside the ${container}, like \`context/\`.`;
  }
  if (prefix.split("/").includes("..")) return "No `..` segments.";
  return undefined;
}

export function hasErrors(errors: ConnectErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Does this endpoint/bucket pair make the addressing style a real question?
 *
 * The whole reason this is a function of the *current form values* rather than
 * something always on screen: almost nobody should ever see it. Asking every
 * person connecting a bucket to pick a URL addressing style is asking them to
 * answer a question about S3's history. Asking the handful whose endpoint
 * genuinely cannot be disambiguated is asking them the only question we cannot
 * answer for them — and getting it wrong writes to the wrong bucket.
 */
export function needsAddressingChoice(values: ConnectFormValues): boolean {
  return addressingIsAmbiguous(values.endpoint.trim(), values.bucket.trim());
}

export const ADDRESSING_OPTIONS = [
  {
    value: "path" as const,
    label: "The bucket is in the path",
    detail: "Path-style: https://host/<bucket>/note.md. Most self-hosted and compatible endpoints.",
  },
  {
    value: "host" as const,
    label: "The bucket is in the hostname",
    detail: "Virtual-hosted: https://<bucket>.host/note.md. Common on Amazon S3.",
  },
];

export type AddressingChoice = (typeof ADDRESSING_OPTIONS)[number]["value"];

export function addressingToForcePathStyle(choice: AddressingChoice): boolean {
  return choice === "path";
}

export function forcePathStyleToAddressing(
  value: boolean | null | undefined,
): AddressingChoice | null {
  if (value === null || value === undefined) return null;
  return value ? "path" : "host";
}

/** What `bindStorage` is actually called with. */
export interface BindStorageArgs {
  workspaceId: string;
  provider: Provider;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * Build the call.
 *
 * `forcePathStyle` and `rootPrefix` are **omitted** rather than sent as
 * `undefined` when they were not chosen. That is not cosmetic: `undefined` is
 * the value the backend reads as "nobody has answered the addressing
 * question", and it is what makes it refuse an ambiguous endpoint instead of
 * guessing. Sending `false` because the toggle happened to start off would be
 * an answer nobody gave.
 *
 * The secret is passed through untrimmed — leading or trailing whitespace in a
 * secret is legal, and "helpfully" stripping it turns a working key into a
 * mysterious auth failure.
 */
export function toBindStorageArgs(
  values: ConnectFormValues,
  workspaceId: string,
): BindStorageArgs {
  const args: BindStorageArgs = {
    workspaceId,
    provider: values.provider,
    endpoint: values.endpoint.trim(),
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    accessKeyId: values.accessKeyId.trim(),
    secretAccessKey: values.secretAccessKey,
  };

  const prefix = values.rootPrefix.trim();
  if (prefix.length > 0) args.rootPrefix = prefix;

  if (values.forcePathStyle !== null) args.forcePathStyle = values.forcePathStyle;

  return args;
}
