---
job: search
search:
  everywhere: true
  min_score: 0.3
  extra_notes: 6
  snippet_chars: 600
came_from: everywhere, with the meaning half opened up
why: Measured on production indexes on 2026-10-10, what a person meant scored 0.40 to 0.63 and queries about nothing in the workspace topped out around 0.34, so 0.30 lets in more of the same-topic notes at the cost of some noise; six meaning-only notes instead of three, since an assistant reads a list and a person scans one; and 600 characters of the matching passage, enough for an assistant to answer a fact without opening the note.
---

Everywhere, a lower meaning cutoff, twice the meaning-only notes, and three times the passage.
