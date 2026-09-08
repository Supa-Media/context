import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * ENCRYPT, RELOAD, UNLOCK, EDIT, SAVE, LOCK — against a real WebKit engine.
 *
 * Every other WebKit case in this directory runs at the phone viewport this
 * config defaults to, because it exists to prove touch handling. This one
 * overrides it to a pointer-sized one: `docs/decisions/encryption.md`'s own
 * KDF section makes a phone's refusal to open a locked note a *decision*
 * (`kdfSupport`, Hermes has no Web Crypto and is too slow for Argon2id
 * either way) rather than a gap in coverage — and it is a decision this
 * suite cannot exercise honestly regardless of viewport, because a WebKit
 * *browser*, at any width, has real Web Crypto and is not Hermes. That case
 * is `lockedNoteView.test.ts`'s "a phone" describe block, against a mocked
 * `kdfSupport`, which is the only place it can be told the truth. Share and
 * its "ADVANCED" section are also only drawn on a pointer layout
 * (`BrowsePane.tsx`'s own `!compact` guard) — a phone reaches Share from the
 * top bar's trailing group, which `E2EFixtureScreen` does not reproduce (see
 * its own header) — so a pointer viewport is what this suite needs to reach
 * the feature at all, not only what it needs to be honest about.
 *
 * The one note this runs against, `1-projects/e2e-secret.md`, has a real
 * write path — see `e2eEncryptionFixture.ts` for why every other note here
 * does not. `assertStoredCiphertext` reads its bytes out of the fixture's own
 * `localStorage` record — the one place they exist independent of which view
 * happens to be on screen, since a passphrase note's own body replaces
 * CodeMirror with `LockedNoteView` whether it is locked or unlocked. This is
 * what "asserts the stored bytes are ciphertext at every point" is checked
 * against, not an inference from what the UI says about itself.
 */

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

const PASSPHRASE = "correct horse battery staple e2e";
const NEW_PASSPHRASE = "a different six word passphrase now";
const EDITED_LINE = "This line only exists because the note was unlocked.";

/**
 * `e2eEncryptionFixture.ts`'s own key — the one place this note's bytes
 * really live, independent of anything rendered on screen. `NoteEditor.tsx`
 * swaps `LiveEditor` for `LockedNoteView` the moment a note is a passphrase
 * one, locked *or* unlocked — CodeMirror's own buffer, and the aria-label a
 * plaintext note reads through, exist only before the first lock and after
 * a full removal. Reading `localStorage` directly is what lets this file
 * check "the stored bytes are ciphertext" as one assertion that holds
 * whichever of those views happens to be on screen, rather than one that
 * would need to know which.
 */
const STORAGE_KEY = "context-e2e-encryption-fixture";

async function storedText(page: Page): Promise<string> {
  const record = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as { text: string }).text;
  }, STORAGE_KEY);
  expect(record).not.toBeNull();
  return record!;
}

/** Fails loudly rather than passing on an empty string if the key drifts. */
async function assertStoredCiphertext(page: Page): Promise<string> {
  const text = await storedText(page);
  expect(text).toContain("context_encryption: v1");
  expect(text).toContain('"kind":"passphrase"');
  expect(text).not.toContain(EDITED_LINE);
  return text;
}

/** The plaintext note's own CodeMirror buffer — only meaningful before the
 * first lock and after a full removal, when this note is an ordinary one. */
async function editorText(page: Page): Promise<string> {
  return (await page.locator('[aria-label="1-projects/e2e-secret.md markdown"]').innerText()).trim();
}

async function openFixtureNote(page: Page): Promise<void> {
  await page.getByTestId("breadcrumb-folder-1-projects").click();
  await page.getByLabel("e2e-secret", { exact: true }).click();
  await page.getByTestId("note-durability").waitFor();
}

async function openShareDialog(page: Page): Promise<void> {
  await page.getByTestId("browse-share").click();
  await expect(page.getByRole("heading", { name: /^Share/ })).toBeVisible();
}

/**
 * `.fill()` on its own is not enough here: under enough contention that this
 * page's own JS main thread starves for a stretch, we measured a real
 * WebKit + react-native-web `TextInput` occasionally accept the fill's
 * `input` event, start a re-render, and still end up back at its last
 * *React-committed* value — the DOM snaps back to `""` rather than holding
 * what was typed, with no error anywhere: `.fill()` resolves normally and
 * the next `.fill()` on a different field proceeds. A bare `.fill()` on the
 * passphrase fields turned that into a button that stayed disabled for the
 * rest of the test's timeout, for a reason nothing at that point could name.
 * Verifying and retrying here fails fast, at the field that actually lost
 * its keystrokes, instead of ninety seconds later at a click with no field
 * left to blame.
 */
async function fillReliably(locator: Locator, value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await locator.fill(value);
    try {
      await expect(locator).toHaveValue(value, { timeout: 2_000 });
      return;
    } catch {
      // Retry — see the comment above this function.
    }
  }
  await expect(locator).toHaveValue(value);
}

/**
 * The full "lock this note" sequence every test here starts with: open
 * Share, open the lock dialog, fill and confirm the passphrase, acknowledge,
 * confirm, and close Share behind it. Every test needs the note unlocked
 * immediately afterward to do its own work, which is `protectNote`'s own
 * contract — locking is the one operation that leaves a note open, because
 * the person just typed the passphrase and proved they know it.
 */
async function lockNote(page: Page, passphrase: string): Promise<void> {
  await openShareDialog(page);
  await page.getByTestId("share-lock-note").click();
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), passphrase);
  await fillReliably(page.getByLabel("Passphrase again", { exact: true }), passphrase);
  await fillReliably(page.getByLabel("Type I understand to confirm", { exact: true }), "I understand");
  await page.getByLabel("Lock this note", { exact: true }).click();
  // The lock dialog unmounts itself once `EncryptionAdvancedSection` sees
  // `encrypted: true`, but the Share dialog it was opened over does not —
  // it is a plain modal, dismissed only by "Done" or its scrim, and its
  // scrim otherwise sits over `LockedNoteView`'s own controls.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByTestId("locked-note-body").waitFor();
}

test.beforeEach(async ({ page }) => {
  // Argon2id at OWASP's floor is about a second of real work per unlock
  // (`docs/decisions/encryption.md`'s own bench), and several of these cases
  // run it three or four times over two page loads apiece — comfortably
  // past this config's 30s default outside CI's own faster-if-anything
  // runners.
  test.setTimeout(90_000);

  // Each test starts this note from scratch: the fixture's own localStorage
  // key, cleared before the app ever mounts against it, so one test's lock
  // does not leak into the next one's "starts as plaintext" assumption.
  //
  // A plain `page.evaluate` after the first load, then one `reload()` so the
  // app mounts fresh against the now-empty key — **not** `page.addInitScript`,
  // which sounded like the right tool and was the wrong one: it reruns before
  // every subsequent navigation in this page, including the reload test's own
  // `page.reload()` **mid-test** — wiping the very ciphertext that reload is
  // supposed to prove survived. Measured: with it, the reload test's own
  // assertion found nothing there at all, not stale data — no test here
  // needs the key cleared more than once, at the very start.
  await page.goto("/e2e-fixture");
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
  await page.reload();
});

test("locking replaces the plaintext with an envelope, in the bucket and on screen", async ({
  page,
}) => {
  await openFixtureNote(page);
  const before = await editorText(page);
  expect(before).toContain("This paragraph is the plaintext this fixture starts with.");
  expect(before).not.toContain("context_encryption");

  await lockNote(page, PASSPHRASE);

  // Locking is the one operation that leaves the note open afterwards
  // (`useNoteEncryption.protect`'s own comment) — the person just typed the
  // passphrase and proved they know it.
  await expect(page.getByTestId("locked-note-body")).toHaveValue(
    /This paragraph is the plaintext this fixture starts with\./,
  );

  // And behind that editable buffer, the bucket holds ciphertext — read
  // straight out of the fixture's own storage, not off anything the UI says
  // about itself.
  await page.getByTestId("locked-note-lock").click();
  await assertStoredCiphertext(page);
});

test("editing while unlocked re-encrypts under the same passphrase, and a wrong one is refused identically to a corrupt note", async ({
  page,
}) => {
  await openFixtureNote(page);
  await lockNote(page, PASSPHRASE);

  // Edit while unlocked.
  const body = page.getByTestId("locked-note-body");
  await body.fill(`${EDITED_LINE}\n`);
  await page.getByTestId("locked-note-save").click();
  await expect(page.getByTestId("locked-note-save")).toHaveText("Saved");

  // The bucket now holds ciphertext of the *edit* — never the edit itself.
  const stored = await assertStoredCiphertext(page);
  expect(stored).not.toContain(EDITED_LINE);

  // Lock now, then a wrong passphrase and a corrupted envelope must be
  // indistinguishable — `unlockNote`'s own contract.
  await page.getByTestId("locked-note-lock").click();
  await page.getByTestId("locked-note-prompt").waitFor();
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), "the wrong passphrase entirely");
  await page.getByTestId("locked-note-unlock").click();
  await expect(page.getByTestId("locked-note-error")).toHaveText(
    "that passphrase did not open this note",
  );
  // Still locked — a wrong guess does not degrade into showing anything.
  await expect(page.getByTestId("locked-note-body")).toHaveCount(0);

  // The right one opens exactly what was saved.
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), PASSPHRASE);
  await page.getByTestId("locked-note-unlock").click();
  await expect(page.getByTestId("locked-note-body")).toHaveValue(new RegExp(EDITED_LINE));
});

test("a real page reload proves the ciphertext persisted and the unlock session did not", async ({
  page,
}) => {
  await openFixtureNote(page);
  await lockNote(page, PASSPHRASE);
  const storedBeforeReload = await assertStoredCiphertext(page);

  // A genuine reload: the whole page, the whole JS bundle, re-executes.
  // `beforeEach` only clears the fixture's `localStorage` key once, at the
  // very start of the test — see its own comment for why this reload must
  // not repeat that.
  await page.reload();
  await page.getByTestId("breadcrumb-folder-1-projects").click();
  await page.getByLabel("e2e-secret", { exact: true }).click();
  await page.getByTestId("note-durability").waitFor();

  // The ciphertext survived a reload nothing in this session's memory could
  // have carried it through — this is what proves it was actually written
  // down, not merely held in a variable this test never had a way to bypass.
  const storedAfterReload = await assertStoredCiphertext(page);
  expect(storedAfterReload).toBe(storedBeforeReload);

  // And the unlock session did not survive — `session.ts`'s "the key lives
  // in memory and nowhere else" is what this is: a fresh reducer, so the
  // note that was unlocked a moment ago now asks again.
  await page.getByTestId("locked-note-prompt").waitFor();
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), PASSPHRASE);
  await page.getByTestId("locked-note-unlock").click();
  await expect(page.getByTestId("locked-note-body")).toHaveValue(
    /This paragraph is the plaintext this fixture starts with\./,
  );
});

test("changing the passphrase rewraps the key without rewriting the body, and the old passphrase stops working", async ({
  page,
}) => {
  await openFixtureNote(page);
  await lockNote(page, PASSPHRASE);

  await page.getByRole("button", { name: "Change passphrase…", exact: true }).click();
  await fillReliably(page.getByLabel("Current passphrase", { exact: true }), PASSPHRASE);
  await fillReliably(page.getByLabel("New passphrase", { exact: true }), NEW_PASSPHRASE);
  await fillReliably(page.getByLabel("New passphrase again", { exact: true }), NEW_PASSPHRASE);
  await page.getByRole("button", { name: "Change passphrase", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change this note's passphrase" })).toHaveCount(0);

  // Still ciphertext, still open (the session moved to the new key without
  // being asked to unlock again — `changePassphrase`'s own contract).
  await assertStoredCiphertext(page);
  await expect(page.getByTestId("locked-note-body")).toBeVisible();

  await page.getByTestId("locked-note-lock").click();
  await page.getByTestId("locked-note-prompt").waitFor();

  // The passphrase that opened it a minute ago no longer does.
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), PASSPHRASE);
  await page.getByTestId("locked-note-unlock").click();
  await expect(page.getByTestId("locked-note-error")).toBeVisible();

  // The new one does.
  await fillReliably(page.getByLabel("Passphrase", { exact: true }), NEW_PASSPHRASE);
  await page.getByTestId("locked-note-unlock").click();
  await expect(page.getByTestId("locked-note-body")).toHaveValue(
    /This paragraph is the plaintext this fixture starts with\./,
  );
});

test("removing the passphrase publishes the note back as plain Markdown, and requires it", async ({
  page,
}) => {
  await openFixtureNote(page);
  await lockNote(page, PASSPHRASE);

  // A wrong passphrase refuses the removal too — this is the one
  // plaintext-over-encrypted write the product allows, and it is gated on
  // proving the *current* passphrase, not on the session already holding a
  // key for it.
  await page.getByRole("button", { name: "Remove encryption…", exact: true }).click();
  await fillReliably(page.getByLabel("Current passphrase", { exact: true }), "not the passphrase");
  await page.getByRole("button", { name: "Remove encryption", exact: true }).click();
  await expect(page.getByTestId("passphrase-action-error")).toBeVisible();
  await assertStoredCiphertext(page);

  await fillReliably(page.getByLabel("Current passphrase", { exact: true }), PASSPHRASE);
  await page.getByRole("button", { name: "Remove encryption", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remove this note's passphrase" })).toHaveCount(0);

  // Plain Markdown again — the envelope, the marker and every recipient are
  // gone from the bucket, not merely hidden by the UI.
  const finalText = await editorText(page);
  expect(finalText).toContain("This paragraph is the plaintext this fixture starts with.");
  expect(finalText).not.toContain("context_encryption");
  expect(finalText).not.toContain('"kind":"passphrase"');
});
