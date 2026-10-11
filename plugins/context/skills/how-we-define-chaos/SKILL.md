---
name: how-we-define-chaos
description: How Context scores a workspace's chaos, and how to organize notes so it goes down. Use when the user asks you to tidy, organize, clean up or restructure their notes or folders, asks about their chaos score, or when a write or move answer reports the score got messier.
---

# How we define chaos

Every Context workspace has a **chaos score** from 0 to 100. Lower is calmer.
`orient` shows it under "Chaos score" with the folders that would calm it
most, and every `write_note`, `move_note`, `move_notes`, `move_folder` and
`archive_note` answer ends with the score before and after:

```
chaos: 34 → 31 of 100 (calmer; lower is calmer)
  1-projects/launch: 14 → 9 items (fine)
```

Nobody tidies for the person automatically. They do it, or they ask you to.
This skill is the rubric, so you can tell a change that helps from one that
only moves the mess around.

## The rubric

A folder's **items** are the notes and subfolders directly in it. Its about
note (`about.md`, `overview.md`, `index.md` or `README.md`) describes the
folder and is not an item. Pictures, attachments and dot files are not items
either.

| Items in a folder | Chaos | What it means |
|---|---|---|
| only its about note | 60 | an empty shell: fill it or fold it into its parent |
| 1 | 40 | move the one note out, to the parent or a sibling |
| 2 | 20 | probably one note, or one of a larger folder |
| 3 | 5 | nearly fine |
| 4 or 5 | 0 | calm |
| 6 to 10 | 5 to 25 | fine; 10 is the average mark |
| 11 to 20 | 29 to 65 | crowded: split by theme into subfolders |
| 35 or more | 100 | chaotic |

- **Runs count as one.** Notes that are one sequence count as one item:
  dated notes (`2026-10-01 standup.md`), a name with a number (`Kings 1` to
  `Kings 30`), or chapters numbered 1 to N with no gaps or repeats. A run
  needs at least three, and counts one item per 30 notes, so a month of daily
  notes is fine and a year of them is twelve items. Past 30, group them by
  month or quarter.
- **Long notes.** A note past 1,000 lines adds chaos: 10 more per 100 lines,
  full chaos at 2,000. A line over 120 characters counts once per 120, so a
  wall of text cannot dodge it. Split a long note by section into a folder of
  notes with an about note. Meetings (`type: meeting`) and notes marked
  `generated: true` are exempt.
- **The workspace** is the average over every note, each carrying its
  folder's chaos (or its own length chaos when that is higher). So a folder
  weighs what it holds: a crowded folder of 80 notes matters far more than a
  thin folder of 2.
- **Never thin:** the root and the built-in folders (Inbox, Projects, Areas,
  Resources, Clients, Teams, Products). They only count as crowded.
- **Never scored:** Archive, and everything under it.
- **The inbox counts.** A full inbox raises the score on purpose. It is the
  reminder that it needs sorting.

## How to organize well

1. Call `orient`, read the "Chaos score" section, and start with the first of
   "Biggest wins". That folder moves the score most.
2. Read before you move. `search_notes` and `read_note` tell you what notes
   are about; their names alone are not enough to split a folder well.
3. **Crowded folder** (over 10 items): find two to five themes and make a
   subfolder for each, every one with an about note that says what belongs
   there. Leave a note where it is if it fits no theme. Do not invent a
   catch-all `misc/`.
4. **Thin folder** (under 4 items): move its notes up into the parent, or
   merge it with a sibling on the same subject, then delete the empty folder.
   A folder holding only its about note: fold that text into the parent's
   about note, or archive it.
5. **Long note**: split it by heading into a folder named after the note,
   with the old opening as its about note. Keep links working by naming the
   new notes after their headings.
6. **Finished work** goes to Archive with `archive_note`; it stops counting.
7. Watch the `chaos: X → Y` line on each answer. If a move made things
   messier, say so, and undo it or try another grouping.
8. Never change what people can see while organizing. A move into a folder
   with wider visibility waits for the person's yes, so ask before you make
   it.
9. Follow the person's own conventions from their front page over this
   rubric. The score is a guide, not a rule they have to obey.

When you finish, tell the person the score before and after, and what you
moved, one line per folder.

If no `context` MCP tools are available, tell the user to run
`npx -y @supa-media/context install`.
