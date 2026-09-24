# Identity, grants, invitations, and ingestion

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Ingestion is on the apex, which makes the reserved-name list a security control

Moved to [Ingestion is on the apex, which makes the reserved-name list a security control](./identity-and-access/ingestion.md#ingestion-is-on-the-apex-which-makes-the-reserved-name-list-a-security-control).

### Mail lands in a personal context and nowhere else

Moved to [Mail lands in a personal context and nowhere else](./identity-and-access/ingestion.md#mail-lands-in-a-personal-context-and-nowhere-else).

### The privacy tier is a scope on the grant, never an inference from a role

Moved to [The privacy tier is a scope on the grant, never an inference from a role](./identity-and-access/grants-and-reach.md#the-privacy-tier-is-a-scope-on-the-grant-never-an-inference-from-a-role).

### A third-party OAuth callback carries a secret the browser kept, not just `state`

Moved to [A third-party OAuth callback carries a secret the browser kept, not just `state`](./identity-and-access/grants-and-reach.md#a-third-party-oauth-callback-carries-a-secret-the-browser-kept-not-just-state).

### The same derived-subjects shape closes a teardown gap, not just a binding gap

Moved to [The same derived-subjects shape closes a teardown gap, not just a binding gap](./identity-and-access/grants-and-reach.md#the-same-derived-subjects-shape-closes-a-teardown-gap-not-just-a-binding-gap).

### A first-party signed shell may have its own grant approved by the session hosting it

Moved to [A first-party signed shell may have its own grant approved by the session hosting it](./identity-and-access/grants-and-reach.md#a-first-party-signed-shell-may-have-its-own-grant-approved-by-the-session-hosting-it).

### One connection reaches every context its person belongs to

Moved to [One connection reaches every context its person belongs to](./identity-and-access/grants-and-reach.md#one-connection-reaches-every-context-its-person-belongs-to).

### One context is pinned for everybody, and the pin is reach rather than membership

Moved to [One context is pinned for everybody, and the pin is reach rather than membership](./identity-and-access/grants-and-reach.md#one-context-is-pinned-for-everybody-and-the-pin-is-reach-rather-than-membership).

### A grant is one person's tooling, and the refusal follows the listing

Moved to [A grant is one person's tooling, and the refusal follows the listing](./identity-and-access/invitations-and-signin.md#a-grant-is-one-persons-tooling-and-the-refusal-follows-the-listing).

### An invitation is addressed to a string, and its token is stored in the clear

Moved to [An invitation is addressed to a string, and its token is stored in the clear](./identity-and-access/invitations-and-signin.md#an-invitation-is-addressed-to-a-string-and-its-token-is-stored-in-the-clear).

### An invitation is delivered, and the delivery is scheduled rather than sent

Moved to [An invitation is delivered, and the delivery is scheduled rather than sent](./identity-and-access/invitations-and-signin.md#an-invitation-is-delivered-and-the-delivery-is-scheduled-rather-than-sent).

### There is no get-invitation-by-token query, and there must not be one

Moved to [There is no get-invitation-by-token query, and there must not be one](./identity-and-access/invitations-and-signin.md#there-is-no-get-invitation-by-token-query-and-there-must-not-be-one).

### The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`

Moved to [The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`](./identity-and-access/invitations-and-signin.md#the-sign-in-links-life-is-signin_code_ttl_ms-and-never-magiclinkmaxage).

### The two onboarding gates ask two different questions

Moved to [The two onboarding gates ask two different questions](./identity-and-access/invitations-and-signin.md#the-two-onboarding-gates-ask-two-different-questions).

### …and a third question nobody was asking: how do you get one?

Moved to […and a third question nobody was asking: how do you get one?](./identity-and-access/invitations-and-signin.md#and-a-third-question-nobody-was-asking-how-do-you-get-one).

### The hook is a capture-only OAuth client, and that is the whole design

Moved to [The hook is a capture-only OAuth client, and that is the whole design](./identity-and-access/agents-and-workspace-identity.md#the-hook-is-a-capture-only-oauth-client-and-that-is-the-whole-design).

### A workspace's name can be given back, and only its owner can give it

Moved to [A workspace's name can be given back, and only its owner can give it](./identity-and-access/agents-and-workspace-identity.md#a-workspaces-name-can-be-given-back-and-only-its-owner-can-give-it).

### OPEN: the local agent and the console agent are two different principals

Moved to [OPEN: the local agent and the console agent are two different principals](./identity-and-access/agents-and-workspace-identity.md#open-the-local-agent-and-the-console-agent-are-two-different-principals).

## The covered-context set is a reach, not an identity

Moved to [The covered-context set is a reach, not an identity](./identity-and-access/agents-and-workspace-identity.md#the-covered-context-set-is-a-reach-not-an-identity).
