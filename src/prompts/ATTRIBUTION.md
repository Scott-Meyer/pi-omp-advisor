# Attribution

The four prompt files in this directory derive from
`src/prompts/advisor/*.md` in oh-my-pi
(https://github.com/can1357/oh-my-pi, npm `@oh-my-pi/pi-coding-agent@17.4.1`),
MIT licensed:

    Copyright (c) 2025 Mario Zechner
    Copyright (c) 2025-2026 Can Bölük
    Copyright (c) 2026 Stencil Labs, Inc.

`advise-tool.md` remains byte-identical. Small changes to `system.md`,
`context-files.md`, and `active-repo-watchdog.md` clarify the observer's limited
context, bounded history and optional primary reasoning, peer role, editable
pending advice, and the uncertainty of the repository hint. Those changes are copyright Scott Meyer, MIT.

If you copy these files onward, carry this notice with them.

See `../../LICENSE` for the full license text and `../../PROVENANCE.md` for the
file-level breakdown of what is copied, ported, and original.
