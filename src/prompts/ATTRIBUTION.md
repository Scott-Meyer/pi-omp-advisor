# Attribution

The four `.md` files in this directory — `system.md`, `advise-tool.md`,
`active-repo-watchdog.md`, and `context-files.md` — are byte-identical copies of
`src/prompts/advisor/*.md` from oh-my-pi
(https://github.com/can1357/oh-my-pi, npm `@oh-my-pi/pi-coding-agent@17.4.1`),
MIT licensed:

    Copyright (c) 2025 Mario Zechner
    Copyright (c) 2025-2026 Can Bölük
    Copyright (c) 2026 Stencil Labs, Inc.

They are intentionally unmodified — not even an added header comment — so that
this port's advisor prompt is bit-for-bit upstream's. An advisor's behavior is a
function of its exact prompt wording, so editing these would make this a
different system rather than a port.

If you copy any of these files onward, carry this notice with them.

See `../../LICENSE` for the full license text and `../../PROVENANCE.md` for the
file-level breakdown of what is copied, ported, and original.
