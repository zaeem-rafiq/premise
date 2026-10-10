# Extension: audience input

Branch `feat/audience`. Browser port `4406`. Read `README.md` in this folder first.

## What it is

People in the room open a short address on their phones and suggest a change in plain words. Each
suggestion waits for the owner, who accepts it with one tap, and only then does it become a request with
a real agent. Strangers never spend model budget directly. Today `docs/spec/03-floor.md` section 1, item
10 says "No audience input", and nothing exists.

## Write the specification first

Create `docs/spec/08-audience.md` with rule ids `AU1`, `AU2`, …, and update item 10 of `03-floor.md`
section 1 to point to it while `features.audience` (new, false) is on. Settle at least:

- **The page.** `/a/<pool>`, phone-first (375 px), both themes: one text field (`MAX_INTENT_CHARS`), a
  Send button, and plain sentences for sent, too fast, the queue is full, and suggestions are closed.
  All its text comes from `src/copy`.
- **The route.** A public `POST /api/pools/{pool}/suggestions`: text validated like an intent; at most
  one suggestion per address every 30 s and a few per minute per pool; at most 50 waiting. The address
  is used only in memory for the limit, never stored, never in an event.
- **The owner.** The Floor lists waiting suggestions with Accept and Dismiss, for the owner only. Accept
  creates the intent with a tag "From the audience" (choose whether that is a new requester value or a
  field, and justify the protocol change you choose). Dismiss removes it. Events carry the suggestion
  text, so Replay shows them; a dismissed one leaves the screen.
- **Off switches.** With `features.audience` off, or the kill switch on, the page says suggestions are
  closed and the route refuses.
- **How people find it.** When the switch is on, the Floor shows the short address in large text. A QR
  code needs a library: propose one (licence, size) in your report rather than adding it.

## Acceptance

Unit tests of validation and the rate limits; workerd tests of the route (limits, the queue cap, the
kill switch, no address stored); browser tests: the phone page at 375 px in both themes, a suggestion
reaching the owner's list, Accept starting an attempt tagged "From the audience", Dismiss, and a visitor
seeing no Accept. The design rules of `03-floor.md` sections 2, 5 and 6 apply (tap targets of 44 px,
contrast, no text in components).

## Paths

`docs/spec/08-audience.md` (new), `docs/spec/03-floor.md` section 1 item 10 and the copy tables of
section 5, `src/worker/routes/suggestions*` (new) and the route table in `src/worker/routes/wiring.ts`,
the Trunk or Floor Durable Object code that keeps the queue, `src/protocol/events.ts` and the reducer
(lead paths, allowed here), `src/floor/components/audience/**` (new) and a page entry for `/a/<pool>`,
`src/copy/**`, `test/workerd/suggestions/**` and `test/e2e/audience/**` (new), and the shared files of
`README.md`'s list.

## The lead's live checks

Open `/a/<pool>` on a phone against `test`, send a suggestion, accept it on the Floor, and watch the
attempt start and land; then try three fast sends to see the limit.
