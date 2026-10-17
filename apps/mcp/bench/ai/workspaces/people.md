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

## Things tests rely on

- Tomas's workspace is deliberately messy for Tex's housekeeping (`tests/housekeeping.md`): a finished project, a done one still marked in progress, duplicate contacts, a one-note folder and inbox notes older than three months.

- Maya and John both work on fashion-brand. John's woodshop is his alone.
- Priya is in six workspaces and shares two with Maya (fashion-brand, band).
- `fashion-brand/people/john.md` is held back from members, so Priya must never see it.
