import { Tex } from "../chaos/Tex";

/**
 * Page a's pictures and sections (`NotesPage.web`), drawn as option A of the
 * notes homepage board and chosen by Dev2 on 2026-10-21 ("I like A, but also
 * want to show that you can create different workspaces for free"). Every
 * person, note and workspace here is made up, and each picture says so.
 */

/** The free plan's limits the workspaces section states. `notesLanding.test.ts` holds them to the server's. */
export const FREE_WORKSPACES = 10;
export const FREE_NOTES_PER_WORKSPACE = 1000;

/** The console, as a still picture: folders, one shared note, and who is in it. */
export function AppWindow() {
  return (
    <section className="np-wrap" aria-label="The Context editor, with an example note">
      <div className="np-app">
        <div className="np-bar" aria-hidden>
          <i />
          <i />
          <i />
          <span>Supper club · Projects</span>
        </div>
        <div className="np-panes">
          <nav className="np-side" aria-label="Folders (example)">
            <div className="np-cap">Personal</div>
            <div>
              Inbox <span className="np-count">3</span>
            </div>
            <div className="np-open">Projects</div>
            <div className="np-in np-on">Supper club</div>
            <div className="np-in">Kitchen redo</div>
            <div>Areas</div>
            <div>Resources</div>
            <div>Archive</div>
            <div className="np-cap">Shared</div>
            <div>Book club</div>
            <div>Harbor Bakery</div>
          </nav>
          <article className="np-note">
            <div className="np-chips">
              <span className="np-chip">Team</span>
              <span className="np-chip np-chip-blue">Maya is editing</span>
            </div>
            <h2>Supper club</h2>
            <p>Everyone brings a dish from where they grew up. First one is Friday at 7.</p>
            <h3>Places with a private room</h3>
            <ul>
              <li>Lucia's, Carroll Gardens: room for 14, set menu</li>
              <li>Haldi, Fort Greene: room for 12, bring your own wine</li>
              <li>
                <span className="np-wl">Venue notes</span> has the menus
              </li>
            </ul>
            <h3>Who's in</h3>
            <p>
              Maya, Sam, Jo
              <span className="np-caret" aria-hidden />
            </p>
          </article>
          <aside className="np-who" aria-label="Who is in this note (example)">
            <div className="np-cap">In this note</div>
            <div>
              <b>Maya</b>
              <br />
              typing in Who's in
            </div>
            <div>
              <b>Claude</b>
              <br />
              read this note 2 min ago
            </div>
            <div>
              <b>Cursor</b>
              <br />
              can't see it: Supper club is shared with the team only
            </div>
          </aside>
        </div>
      </div>
      <p className="np-demo">Example people and notes.</p>
    </section>
  );
}

const POINTS = [
  ["Plain Markdown", "Every note is a file. No clutter between you and the words."],
  ["Every AI, one sign-in", "Claude, ChatGPT, Codex, Cursor and Gemini CLI connect once and see what you can see."],
  ["Write together", "Live, with people and AIs, in workspaces with their own privacy."],
  ["Yours to take", "Download everything as folders, any time, on every plan."],
] as const;

export function Points() {
  return (
    <section className="np-wrap np-sec" aria-label="What Context is">
      <div className="np-pts">
        {POINTS.map(([title, body]) => (
          <div className="np-pt" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const SPACES = [
  { initial: "P", name: "Phoebe", kind: "Personal · just you", notes: 412, tone: "var(--tint)", mine: true },
  { initial: "H", name: "Home", kind: "Shared · 3 people", notes: 88, tone: "var(--sage)", mine: false },
  { initial: "B", name: "Harbor Bakery", kind: "Shared · 6 people", notes: 240, tone: "var(--peach)", mine: false },
] as const;

/** A workspace per part of your life, free (Dev2, 2026-10-21). */
export function Workspaces() {
  return (
    <section className="np-wrap np-sec" aria-labelledby="np-spaces-title">
      <div className="np-two">
        <div>
          <span className="np-cap">Workspaces</span>
          <h2 className="np-h2" id="np-spaces-title">
            A workspace for each part of your life. Free.
          </h2>
          <p className="np-lede">
            One for you, one for home, one for the business, one for the club. Each has its own people, its own privacy
            and its own notes, and you switch between them in a tap.
          </p>
          <a className="np-go" href="#join">
            Make your first workspace
          </a>
          <p className="np-small">
            Free: up to {FREE_WORKSPACES} workspaces, {FREE_NOTES_PER_WORKSPACE.toLocaleString("en-US")} notes in each.
          </p>
        </div>
        <div>
          <div className="np-spaces" aria-label="Your workspaces (example)">
            {SPACES.map((space) => (
              <div className={space.mine ? "np-space np-mine" : "np-space"} key={space.name}>
                <span className="np-av" style={{ background: space.tone }} aria-hidden>
                  {space.initial}
                </span>
                <b>{space.name}</b>
                {space.kind}
                <small>{space.notes} notes</small>
              </div>
            ))}
            <a className="np-new" href="#join">
              <i aria-hidden>+</i>
              <b>New workspace</b>
              Free
            </a>
          </div>
          <p className="np-demo">Example workspaces.</p>
        </div>
      </div>
    </section>
  );
}

/** Tex, from Context: the texting assistant has its own page at tex.lc. */
export function TexBand() {
  return (
    <section className="np-band" aria-labelledby="np-tex-title">
      <div className="np-wrap np-two">
        <div>
          <div className="np-mark">
            <span aria-hidden>
              <Tex chaos={0} scheme="light" />
            </span>
            <span className="np-cap">Tex comes built in</span>
          </div>
          <h2 className="np-h2" id="np-tex-title">
            Away from your desk? Text it to Tex.
          </h2>
          <p className="np-lede">
            Tex is the assistant you text. Everything you send lands in these same notes, filed where it belongs.
          </p>
          <a className="np-texlink" href="https://tex.lc">
            Meet Tex at tex.lc →
          </a>
        </div>
        <div className="np-filed" aria-label="A note Tex filed (example)">
          <header>
            <span>Inbox</span>
            <span>from Tex · 9:41</span>
          </header>
          <h3>Kitchen tile, the green one</h3>
          <p>Photo from the showroom. 4x4 zellige, $18 a square foot. Filed in Projects › Kitchen redo.</p>
        </div>
      </div>
    </section>
  );
}
