# `prototypes/` — review artifacts, never production

Nothing in this folder ships. It is not under `app/`, so Expo Router cannot
route to it; nothing in `features/` imports it; and the only thing that mounts
it is a shot script asked for by name (`scripts/premium-ux-shots.ts`).

It exists because a flow that has not been drawn cannot be critiqued, and
because a drawing made in a design tool would be a picture of a product that
does not use this app's type, spacing, colours or components. Everything here
is built from `features/design`, and — wherever the real screen already exists
— from the real screen's own modules, so what is reviewed is what would ship
rather than an impression of it.

Two rules that keep this folder honest:

- **A prototype may not claim a capability the backend does not have.** Every
  frame carries its own evidence list saying which of its controls are built,
  which need backend work, and which are proposals. `frames.tsx` holds those
  lists beside the frames themselves so they cannot drift apart.
- **A prototype may never be promoted by import.** When a frame is approved,
  the production version is written in `features/`, and the frame here is
  deleted or left as the record of what was approved. Importing this folder
  from `features/` would put un-reviewed copy in the product.

Current contents: `premium/`, the review pack for Premium and managed storage
(`docs/design/premium-ux/README.md` is the index a reviewer starts from).
