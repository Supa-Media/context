/**
 * Who is signed in — which is not the same question as what is being viewed.
 *
 * The account block at the foot of the rail, and the avatar it shares an
 * initial with, are statements about **the viewer**: this is you, this is your
 * capture address, this is the way out. They used to be derived from the
 * *selected* context — the avatar took the selected slug's initial, and the
 * name took the first `kind === "personal"` context in the list, which is
 * somebody *else's* personal context the moment one is shared with you. Click
 * into a colleague's context and the console renamed you after them,
 * everywhere at once. The top-left chip is the one surface allowed to name the
 * viewed context, because naming it is that chip's whole job.
 *
 * So the identity is resolved here, once, from facts about the viewer alone:
 *
 *  - **Their own personal context** — `kind === "personal"` *and* `role ===
 *    "owner"`. The kind alone is not ownership: a personal context shared with
 *    you keeps its kind and is still not you. The handle is the identity in
 *    this product (a name addresses the sole owner of the personal context it
 *    names), so its slug is the name and its capture address is the detail.
 *  - **An invited-only viewer** — someone who owns nothing, living entirely in
 *    contexts other people granted. They still have an identity: the email
 *    they signed in with, which the selected context's member list already
 *    carries on the row marked `isMe`. Never the viewed context's slug — that
 *    is precisely the bug this module exists to end.
 *  - **Neither yet** — the lists are still loading, or the member list has no
 *    usable address. A neutral "Signed in" beats borrowing anybody's name for
 *    the gap.
 */

import { atName } from "./format";
import { placeholderIngestionAddress } from "./placeholderData";

export interface ViewerIdentity {
  /** "@seyi", or the sign-in email, or "Signed in". */
  name: string;
  /** The viewer's own capture address; absent when they own no context. */
  detail?: string;
  /** For the avatar. Derived from `name`'s source, never from the viewed context. */
  initial: string;
}

interface IdentityContext {
  slug: string;
  kind: string;
  role: string;
}

/**
 * The context that *is* this person: personal, and theirs. `null` for an
 * invited-only account. `kind` alone is not enough — see the file comment.
 */
export function ownPersonalContext<C extends IdentityContext>(
  contexts: readonly C[],
): C | null {
  return contexts.find((c) => c.kind === "personal" && c.role === "owner") ?? null;
}

export function viewerIdentity({
  contexts,
  ownAddress,
  email,
}: {
  contexts: readonly IdentityContext[];
  /**
   * The real issued capture address of the viewer's own personal context, when
   * a subscription has answered for it. Falls back to the derived address for
   * their own slug — the same formula the backend applies — never to another
   * context's.
   */
  ownAddress?: string;
  /** The signed-in account's email, from the member row marked `isMe`. */
  email?: string;
}): ViewerIdentity {
  const own = ownPersonalContext(contexts);
  if (own !== null) {
    return {
      name: atName(own.slug),
      detail: ownAddress ?? placeholderIngestionAddress(own.slug),
      initial: own.slug.slice(0, 1).toUpperCase(),
    };
  }

  const address = email?.trim();
  if (address !== undefined && address.length > 0) {
    return { name: address, initial: address.slice(0, 1).toUpperCase() };
  }

  return { name: "Signed in", initial: "?" };
}
