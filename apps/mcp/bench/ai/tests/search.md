---
job: search
run_as: Maya
today: 2026-10-08
runs: 1
good_enough:
  found: 90%
  top3: 85%
---

# Search test

Written 2026-10-10, when the owner asked for search to be measured the way the
assistant's prompt is ("a testing pipeline for search, using the same
pipeline"). Each question is one `search_notes` call, as the person named,
with no `context` unless an `in:` line gives one; the notes under `expect:`
are the ones that answer it, as `@workspace/path`. A question passes when an
expected note is in the answer at all, and counts for the top-three bar when
one is in the first three. Nothing here is judged by a model.

The queries are the texting assistant's own questions and the words a person
would type, not the words the note uses, so the two halves of search are both
measured: the ones that share a word with the note are the word search's, and
the ones that share none ("tooth cleaning", "fabric mill") are the meaning
search's. Questions with no `in:` are asked from the person's own workspace,
which is where an assistant starts; whether the note in another workspace comes
back is what the `everywhere` setting decides.

## 1. dentist appointment

- expect: @maya/health/dentist.md

## 2. when do I land in Lisbon

- expect: @maya/trips/lisbon.md

## 3. packing for the trip

- expect: @maya/trips/lisbon-packing.md

## 4. how much of the travel fund is still to pay

- expect: @maya/money/budget-2026.md

## 5. plumber for the bathroom tap

- expect: @maya/home/apartment-repairs.md

## 6. who recommended a plumber

- expect: @maya/people/sam.md

## 7. did the landlord reply about the tap

- expect: @maya/home/apartment-repairs.md

## 8. my running intervals this week

- expect: @maya/health/running-plan.md

## 9. what am I cooking on weeknights

- expect: @maya/recipes/weeknight-dinners.md

## 10. tooth cleaning last time

- expect: @maya/health/dentist.md

## 11. flat in Lisbon, is it booked

- expect: @maya/trips/lisbon.md

## 12. Ana's train on the first day

- expect: @maya/people/ana.md, @maya/trips/lisbon.md

## 13. load-in time for the Velvet Anchor

- expect: @band/gigs/velvet-anchor-oct.md

## 14. open mic sign-up

- expect: @band/gigs/open-mic-nov.md

## 15. which song are we still learning

- expect: @band/setlists/summer-set.md

## 16. next band session

- expect: @band/rehearsal/schedule.md

## 17. twill order from the fabric mill

- expect: @fashion-brand/todo.md, @fashion-brand/suppliers/harbor-linen-mill.md

## 18. when does Dana need quantities

- expect: @fashion-brand/suppliers/harbor-linen-mill.md, @fashion-brand/inbox/harbor-linen-email-oct.md

## 19. what is John working on outside the brand

- expect: @fashion-brand/people/john.md

## 20. line sheet for spring

- expect: @fashion-brand/collections/spring-26-line-sheet.md

## 21. the gig on the 17th

- in: @band
- expect: @band/gigs/velvet-anchor-oct.md

## 22. wool supplier

- in: @fashion-brand
- expect: @fashion-brand/suppliers/quarry-wool-works.md

## 23. physio check-up

- as: John
- expect: @john/health/shoulder-physio.md

## 24. planer blades budget

- as: John
- expect: @john/money/tools-budget.md

## 25. has Ruth paid her deposit

- as: John
- expect: @woodshop/projects/shelf-commission.md, @john/people/ruth.md

## 26. how to reach Ruth

- as: John
- expect: @john/people/ruth.md

## 27. borrow a router table

- as: John
- expect: @john/people/tomas.md

## 28. walnut for the credenza, the cost

- as: John
- expect: @woodshop/projects/walnut-credenza.md, @woodshop/suppliers/east-lumber-yard.md

## 29. when is the glue-up

- as: John
- expect: @woodshop/projects/walnut-credenza.md

## 30. shelves for Ruth, how deep

- as: John
- expect: @woodshop/projects/shelf-commission.md

## 31. garage lights flickering

- as: John
- expect: @john/home/garage-lights.md

## 32. trip to the coast with Ruth

- as: John
- expect: @john/trips/coast-november.md

## 33. lumber delivery

- as: John
- in: @woodshop
- expect: @woodshop/todo.md, @woodshop/suppliers/east-lumber-yard.md

## 34. savings for the flat

- as: Priya
- expect: @priya/money/savings-goal.md

## 35. lease renewal form

- as: Priya
- expect: @priya/home/lease-renewal.md

## 36. 6 pm yoga in November

- as: Priya
- expect: @priya/health/yoga-schedule.md

## 37. December visit, is it booked

- as: Priya
- expect: @priya/trips/december-visit.md

## 38. caterer total before service charge

- as: Priya
- expect: @wedding-planning/vendors/caterer.md

## 39. is the band playing at the wedding

- as: Priya
- expect: @wedding-planning/decisions/log.md

## 40. tasting menu in November

- as: Priya
- expect: @wedding-planning/vendors/caterer.md

## 41. where are we with the wedding

- as: Priya
- expect: @wedding-planning/index.md, @wedding-planning/timeline/checklist.md, @wedding-planning/decisions/log.md

## 42. venue deposit paid

- as: Priya
- expect: @wedding-planning/venue/deposit.md

## 43. book club this month

- as: Priya
- expect: @book-club/meetings/2026-10.md

## 44. what are we reading

- as: Priya
- expect: @book-club/books/current.md

## 45. conference slides deadline

- as: Priya
- expect: @day-job/travel/conference-2026.md, @day-job/status/weekly-status.md

## 46. soup for the book club

- as: Priya
- expect: @priya/recipes/sunday-soup.md

## 47. Mina's address for the meeting

- as: Priya
- expect: @priya/people/mina.md, @book-club/meetings/2026-10.md

## 48. Owen visiting

- as: Priya
- expect: @priya/people/owen.md

## 49. who left the team

- as: Priya
- expect: @day-job/people/team.md

## 50. what does John earn

- as: Priya
- expect: @fashion-brand/people/john.md
- mirror: 19
