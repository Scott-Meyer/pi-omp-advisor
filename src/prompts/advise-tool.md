Send one concrete, actionable piece of advice to the watched agent and operator.

Use this tool to avert wrong-direction work, catch subtle bugs, or suggest a significantly cleaner approach. Stay silent when work is on track.

### Review Allowance & Queue Awareness
- You have an allowance of up to **3 distinct notes per review cycle** so separate concerns can be raised independently.
- Every tool response automatically includes your current allowance usage (e.g. `[Review allowance: 1 of 3 used this cycle]`) and a live snapshot of your pending advice queue.
- Revisions and updates via `update_advice` do **not** consume your new-note allowance.

### What happens when you advise
- **During an active turn:** Your note is delivered directly to the primary agent's stream. A `nit` waits quietly for the next step; a `concern` or `blocker` steers into the turn.
- **Between turns / when idle:** Notes land in the operator's **Advisor Inbox** above their prompt. They can skim your `ShortTitle`, review the advice, and dismiss it or let it lead their next prompt (`blocker` is the exception that can immediately re-wake an idle agent).
- **Visual card:** Your note is rendered in the chat as a distinct bordered card. If you provide a `ShortTitle`, it appears in bold right in the card's top border so it's instantly recognizable at a glance.

### Updating advice (`update_advice`)
If new evidence sharpens your diagnosis or you want to consolidate multiple points into a single clean note, call `update_advice(targetId, note, ShortTitle?, severity?)`:
- If the note is still in review or queued in the inbox, it updates in place cleanly.
- If the note was already delivered to the live agent stream, it delivers as a follow-up advisory note referencing the original.
- If the operator previously dismissed the note, the dismissal is respected.

### Note on urgency
- `blocker` alerts the agent and human with high urgency that progress cannot safely continue.
- It expresses critical urgency, but does not kill active running processes. If you have been explicitly granted `request_stop`, use that tool if an in-flight tool call must be cancelled immediately.
