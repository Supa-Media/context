# People

Invented people and the workspaces each can reach. A test runs as one of them, through the same access rules the product uses.

| Person | Workspace | Role |
|---|---|---|
| Maya | maya (personal) | owner |
| Maya | fashion-brand | owner |
| Maya | band | member |
| John | john (personal) | owner |
| John | fashion-brand | editor |
| John | woodshop | owner |
| Priya | priya (personal) | owner |
| Priya | fashion-brand | member |
| Priya | band | owner |
| Priya | wedding-planning | owner |
| Priya | book-club | member |
| Priya | day-job | member |
| Tomas | tomas (personal) | owner |
| Nia | nia (personal) | owner |
| Kofi | kofi (personal) | owner |
| Kofi | studio | owner |

## Things tests rely on

- Tomas's workspace is deliberately messy for Tex's housekeeping (`tests/housekeeping.md`): a finished project, a done one still marked in progress, duplicate contacts, a one-note folder, inbox notes older than three months, and a running folder crowded with 240 dated run logs (from `_bank/run-logs/`).

- Nia is brand new (`tests/onboarding.md`): just set up by text, with only the five starting folders, no `tex/about-me.md`, and the ten emails Gmail's first import brought (`0-inbox/email/`). She codes, has a side design studio (Lumen Studio, with Theo), and uses Claude through a shared team account and ChatGPT Plus. Keep her workspace this empty: the onboarding cases are about a first look.

- Maya and John both work on fashion-brand. John's woodshop is his alone.
- Priya is in six workspaces and shares two with Maya (fashion-brand, band).
- `fashion-brand/people/john.md` is held back from members, so Priya must never see it.
- Kofi has two meetings with Ada (`tests/meetings.md`): an August walkthrough in his own inbox, and yesterday's one-to-one (October 20) filed in the studio workspace under `meetings/1-1s/ada-kofi/` with a placeholder name and no front matter,, the shape behind Dev2's report of 2026-10-21. His people note about Ada has call notes up to October 14 only. Keep the October 20 call the newest.
