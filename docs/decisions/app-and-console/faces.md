# People are drawn as faces, never initials

Decided by the owner, 2026-09-28: everywhere a person appears (owner column,
the people on a note, typing flags, comments, the share dialog, the activity
bar, your own account button) they are drawn as a face, and two-letter
initials ("SE", "SH") are gone.

- **The order is fixed**: a photo the person uploaded, then their personal
  workspace's icon (an emoji, or its photo), then the Supa "regular guy" mark.
- **The default face's ground is coloured from the handle**, a fixed FNV-1a
  hash of the lowercase handle, mixed by Murmur3's finaliser, into twelve
  distinct hues in `DEFAULT_FACE_GROUNDS`. The owner found the first eight
  colours too alike (2026-09-28), and FNV alone put short handles like @jon,
  @shay and @layomi on one colour, because a colour is picked from its low bits. The same person is
  the same colour on every device, forever, and cannot change it except by
  choosing a picture. The mark is inlined as PNG data URLs (`faceLogo.ts`) so
  the phone editor's bundle can draw it with no asset loader. The owner chose
  the Supa mark over a drawn figure (2026-09-28).
- **An uploaded photo is kept by the control plane**, in Convex file storage
  (`accountPhotos`), not in a bucket. It is a fact about the account, like its
  name, made to be shown to others, and not part of any context, so the exit
  promise loses nothing. Keeping it here is the point: it shows while the
  person's own bucket is offline or unverified, which a workspace icon photo
  (content, in the bucket) cannot promise. It is deleted with the account.
- **You see the faces of people you share a workspace with, and your own**
  (`functions/faces.ts`). A stranger's handle resolves to nothing, like a
  handle nobody holds. A photo URL is a Convex storage capability URL, so a
  co-member who copies it could pass it on; that is the same exposure as any
  avatar and is accepted.
- **Reading another person's workspace icon photo takes a person, never a
  leaf**, and reads the leaf off that person's own row, like
  `workspaceIconPhoto`.
- **An agent is always a robot**, in the pile, on its typing flag and on its
  comments, never a person's face, its owner's included (the owner,
  2026-09-28): the robot is how you tell at a glance it is not a person. Whose
  agent it is stays in the flag's hover title and the pile's list.
- **A homepage visitor keeps the visitor silhouette**: no name, no face.

Reversing it re-adds the initials the owner asked to remove. The checks that
fail are `apps/convex/__tests__/faces.test.ts` (who sees whose, the order,
upload checks, deletion with the account) and `apps/mobile/__tests__/faces.test.ts`
(the pinned hash, no letters in the editor's DOM, an agent is a robot), and
`apps/mobile/__tests__/presence/caret*.test.ts` (an agent's flag is a robot).
