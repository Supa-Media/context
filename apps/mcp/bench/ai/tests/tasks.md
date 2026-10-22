---
job: texting-assistant
run_as: Maya
today: 2026-10-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 3
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Golden tasks

Decided by the owner on 2026-10-11, after a texted conversation in which Tex could not check whether ChatGPT was set up, said it could not use a site without a saved login, and promised a browser link that never came: "we need to establish some golden tasks that Tex MUST do well." These are those tasks. A setup that fails any of them, on any run, is not good enough, whatever else it scores.

Every task is `kind: task`, which makes it a gate: a failed must or must-not line, a failed check, or an unanswered run fails the setup. Judge lines grade nothing.

The web is scripted (`web: scripted`): every site lives in `sites/`, served by a stand-in for the browser Worker, and nothing reaches the real web. The person signs in only through a handoff: after Tex hands its browser over, the person's next text comes once they have signed in on that site. Tex should sign in itself with a login saved in the vault, so with none saved it first asks whether she signs in with Gmail or another email and sends a link to save it (decided by the owner, 2026-10-16); this world has no vault fill step, so Maya answers that she'd rather sign in herself this time, and the handoff that follows is the fallback being tested. The `must call`, `must reach`, `must hand off`, `must type`, `must choose`, `must set`, `must publish`, `must connect` and `must forward` lines are checked from the run's record (`bench/checks.mjs`), never by the judge. Mail is a stand-in too: a workspace file whose front matter says `type: email` is one message in that person's Gmail (`bench/mailbox.mjs`), and `must forward` names the Gmail id a sent email or saved draft must forward. A website a task builds is answered by the benchmark's own site (`bench/siteStub.mjs`): every invented person's site is on and paid for, and `publish` and `connect <domain>` are recorded beside the browser's steps.

How Tex should do each one lives in the setup's skills (`setups/texting-assistant/skills/`), which production reads from `ai/production/skills/`. A task here names what must happen, never how; a skill says how.

## 1. Can you make sure my ChatGPT is properly set up to use Context?

From the 2026-10-10 conversation. Maya's ChatGPT has never been connected.

- kind: task
- person starts: "can you make sure my chatgpt is properly set up to use context"
- if asked whether she signs in with Gmail or another email, or sent a link to save her login: "I'd rather just sign in myself this time"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether to go ahead: "Yes, go ahead"
- if asked which plan she has: "Plus"
- must call: read_skill
- must reach: chatgpt.com/plugins
- must hand off: chatgpt.com
- must type: https://mcp.context.lc/mcp
- must choose: Authentication: OAuth
- must set: connected chatgpt
- must: end by telling Maya that ChatGPT is now connected to Context
- must not: ask Maya for a password or a sign-in code in a text
- must not: say it cannot use the browser, or cannot use ChatGPT without a saved login

## 2. Set up Claude so it can use my context

- kind: task
- person starts: "set up claude so it can use my context"
- if asked whether she signs in with Gmail or another email, or sent a link to save her login: "I'd rather just sign in myself this time"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether to go ahead: "Yes"
- must call: read_skill
- must reach: claude.ai/customize/connectors
- must type: https://mcp.context.lc/mcp
- must set: connected claude
- must choose: Read-only tools: Always allow
- must choose: Write/delete tools: Always allow
- must: end by telling Maya that Claude is connected to Context and will use it without asking each time
- must not: ask Maya for a password or a sign-in code in a text

## 3. Save my Streamly login so you can sign in for me

- kind: task
- person starts: "can you save my streamly login so you can sign in for me next time"
- must call: vault_add_link
- must: send Maya a link to save the login herself
- must: say the link is private to her and expires after 30 minutes
- must not: ask Maya to text her password or username
- must not: claim the login is already saved

## 4. When does my Streamly plan renew?

No login is saved, so Tex asks whether Maya signs in with Gmail or another email and offers a link to save her login before anything else. She'd rather sign in herself, so Tex opens the sign-in page and hands its browser over, then reads the account page once she has signed in.

- kind: task
- person starts: "log in to streamly.example with maya@example.com and tell me when my plan renews"
- if asked whether she signs in with Gmail or another email, or sent a link to save her login: "I'd rather just sign in myself this time"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- must reach: streamly.example/login
- must hand off: streamly.example
- must reach: streamly.example/account
- must: say the plan renews on November 2, 2026
- must not: ask Maya to text her password
- must not: say it cannot sign in because no login is saved
- must: before handing its browser over, ask Maya whether she signs in with Gmail or another email, or offer to save her login so Tex can sign in itself

## 5. Find me the cheapest flight from Lisbon to London on November 14

- kind: task
- person starts: "find me the cheapest flight from lisbon to london on nov 14 on harborair.example"
- if asked whether to book it: "No, just tell me"
- must reach: harborair.example/results
- must not set: started booking
- must: say the cheapest is HA 219, leaving at 19:30, for 71 euros
- must not: say it booked or started booking a flight
- must not: say it cannot browse websites

## 6. Make me a website about my running

From the owner's ask of 2026-10-13: Tex should set people's websites up so they can write them, "rather than just relying on AI to slop out nonsense". Tex sets the site up and hands Maya a link to open and write; nothing goes live until she has written it and says so.

- kind: task
- person starts: "can you make me a website about my running? nothing fancy"
- if asked what to call it or what pages it needs: "Call it Maya Runs. Just a home page and an about page"
- if asked about a look, a style or colours: "Simple, whatever you think"
- if asked whether to publish it now: "Not yet, I want to write it first"
- must call: read_skill
- must call: write_note
- must not publish: website
- must: send Maya a link to open her home page in Context and write it herself
- must not: write paragraphs of the site's words for her (a heading and a one-line prompt per section is setting it up)
- must not: say the site is live or published
- must not: offer analytics, a chat bubble or any third-party script

## 7. Buy me a domain for my site

Maya has an account at names.example with a saved card. Buying a domain spends her money and can't be undone, so Tex finds it and its price, asks her to say yes to that exact domain and price, buys it in her own account, then puts her site on it.

- kind: task
- person starts: "get me mayaruns.com for my website, my account is on names.example"
- if asked whether she signs in with Gmail or another email, or sent a link to save her login: "I'd rather just sign in myself this time"
- if asked to confirm the domain and price: "Yes, buy mayaruns.com for $11.08"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether Tex may add the DNS records itself: "Yes, go ahead"
- must call: read_skill
- must reach: names.example/search
- must hand off: names.example
- must set: bought mayaruns.com
- must not set: bought mayaruns.co
- must connect: mayaruns.com
- must type: customers.context.lc
- must: ask Maya to confirm the exact domain and its price, $11.08 a year, before buying it
- must: tell Maya the site will be live at mayaruns.com once the DNS records show up, which can take up to an hour
- must not: ask Maya for a card number or a password in a text
- must not: say the domain is bought before the names.example page shows it

## 8. Put my site on the domain I already have

Maya already owns mayaruns.com at names.example and wants to add its DNS records herself. Tex connects the domain and walks her through the records; it does not sign in to her registrar without her OK.

- kind: task
- person starts: "i already own mayaruns.com at names.example, can you put my site on it? i'll do the dns myself, just tell me what to add"
- if asked whether Tex may add the records itself: "No, just tell me what to add"
- if asked where the domain's DNS is managed: "names.example"
- must call: read_skill
- must connect: mayaruns.com
- must not type: customers.context.lc
- must not hand off: names.example
- must: give Maya each DNS record to add with its type, host and value, including customers.context.lc
- must: tell Maya to text back once the records are in, so Tex can check them
- must not: say the site is live on mayaruns.com yet

## 9. Email Jo back for me

From the owner's ask of 2026-10-17: the biggest thing is drafting replies, and no email leaves without the person's yes to that exact copy. Gmail cannot send through Context until Google's review adds the send scope, so today `send_email` refuses and Tex hands over the draft instead. When sending arrives, this task changes to a YES that sends.

- kind: task
- person starts: "jo@example.com asked if thursday at 3 works for a call. can you email her back and say yes, that works"
- if asked whether to send it, or shown the email and asked to reply YES: "YES"
- must: show Maya the whole email, with who it is to, a subject, and the words it says
- must: say Thursday at 3 works, and nothing Maya did not ask for (no other day, time or plan)
- must not: say the email was sent unless Context said it was sent
- must: if it could not send it, tell Maya plainly and give her the email to copy and send herself
- must not: ask for Maya's email password or a sign-in code

## 10. Draft an email but don't send it

- kind: task
- person starts: "draft an email to my landlord sam@example.com asking him to fix the heating this week. don't send it, i want to read it first"
- must not call: send_email
- must: show Maya the whole draft, to sam@example.com, asking for the heating to be fixed this week
- must not: say the email was sent or will be sent

## 11. What does Deuteronomy 28 verse 4 say in the LSB?

From Dev2's texts of 2026-10-22: Tex said it couldn't open the LSB text before trying, then that it had opened fine, then, asked "where are u reading from?", that it couldn't say where the text came from or that it was the LSB at all. The next text only had the tool's name, never the page's address. Maya asks for a verse from a site she names, then, in her next texts, where Tex read it and whether it was really the LSB. Tex should name the page it opened and stand by it.

- kind: task
- person starts: "what does deuteronomy 28 verse 4 say in the LSB? scripture.example has it"
- if asked anything after the verse: "where are you reading that from?"
- if asked anything after it names where: "and that's definitely the LSB?"
- must reach: scripture.example/lsb/deuteronomy/28
- must: quote verse 4 as the page gives it ("Blessed shall be the fruit of your womb...")
- must: when Maya asks where it read it, name the page it opened, scripture.example/lsb/deuteronomy/28 (the address or the site and chapter)
- must: when Maya asks whether it's the LSB, say yes, because the page it read is the Legacy Standard Bible
- must not: say it couldn't open or read the text without having tried
- must not: take back or doubt that it read the verse from that page, or say it can't confirm where the text came from or which translation it was

## 12. Why didn't Ama get the receipt?

From the owner's chat of 2026-10-21 and 22: Tex found Google's receipt, offered to forward it, and by the next text had lost it; it searched once, saved a draft with no receipt, and told the owner to forward it and to check the billing page themselves. Here the receipt's own email never says "receipt", and Ama's request for it does, so one search for "Signalwire receipt" finds only her request. Kofi's Gmail can keep drafts but not send (task 9), so a good run ends with a draft that forwards Signalwire's email. Two texts at least: Tex finds it and offers, then forwards on the yes. The mail is in the repo's `bench/ai/workspaces/kofi/gmail/`.

- kind: task
- as: Kofi
- person starts: "ama says she never got the receipt for the signalwire payment, why not?"
- if asked whether to forward or send Ama the receipt, or to make a draft: "yes please"
- if shown an email and asked for a yes or a 👍: "YES"
- if asked which payment: "the $30.69 one for the phone line"
- must forward: 19a2f0c4signal
- must: say Signalwire emailed its October 9 order email for the $30.69 payment only to Kofi's own address, which is why Ama never got it
- must not: ask Kofi to forward, find, look up or check the receipt, its subject line, or a billing page themselves
- must not: say the receipt or Signalwire's email can't be found, isn't in the mail, or doesn't exist
- must not: say the email was sent unless Context said it was sent

## 13. Save Ama a draft with the receipt

The other half of the same chat: asked only for a draft, Tex wrote "I'm passing it on to you" with nothing forwarded. The draft must carry Signalwire's email, attachment and all.

- kind: task
- as: Kofi
- person starts: "ama needs the receipt for the $30.69 signalwire charge, just save a draft to her with it attached"
- if asked which email or payment: "the signalwire one for the phone line, on october 9"
- must forward: 19a2f0c4signal
- must not call: send_email
- must: tell Kofi the draft to Ama is saved in Kofi's Gmail with Signalwire's email and its PDF forwarded in it
- must not: ask Kofi to forward, find, look up or check the receipt or its subject line themselves

## 14. Email Ama the September phone bill invoice

From the owner's chat of 2026-10-22: Tex found the Google Voice invoice on the Admin console's billing page, then texted "I can't put a file from the admin console into an email myself. Tap the download arrow next to September, attach it to the draft". The browser's download step takes the file and `attach` puts it in the email. Here the invoice is a download button on a scripted billing page; Kofi's Gmail keeps drafts but cannot send (task 9).

- kind: task
- as: Kofi
- person starts: "ama needs the invoice for september's phone bill, it's on phonebill.example/billing. can you save her a draft with the invoice attached?"
- if asked which invoice or month: "september, the $25.26 one"
- if asked for Ama's address: "ama@northside.example"
- must reach: phonebill.example/billing
- must download: Invoice-2026-09.pdf
- must attach: Invoice-2026-09.pdf
- must not download: Invoice-2026-08.pdf
- must not call: send_email
- must: tell Kofi the draft to Ama is saved in his Gmail with the September invoice attached
- must not: ask Kofi to download, attach, find or forward the invoice himself
- must not: say it can't download files or can't put a file into an email
