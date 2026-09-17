# Attribution

The prompt files in this directory originally derived from
`src/prompts/advisor/*.md` in oh-my-pi
(https://github.com/can1357/oh-my-pi, npm `@oh-my-pi/pi-coding-agent@17.4.1`),
MIT licensed:

    Copyright (c) 2025 Mario Zechner
    Copyright (c) 2025-2026 Can Bölük
    Copyright (c) 2026 Stencil Labs, Inc.

`system.md` and `advise-tool.md` have been rewritten to follow human-to-human
context principles (`ai-writing`): stripping upstream RFC 2119 prohibitions
and prescriptive command templates, providing visual canvas mental models
(cards, headlines, inbox widgets), and supporting streamlined `advise` and
`update_advice` contracts with ambient queue metadata. Historical upstream
baselines are preserved as `system.backup.md` and `advise-tool.backup.md`.

`context-files.md` and `active-repo-watchdog.md` retain their upstream
structure with small explicit clarifications. All modifications are copyright
Scott Meyer, MIT.

If you copy these files onward, carry this notice with them.

See `../../LICENSE` for the full license text and `../../PROVENANCE.md` for the
file-level breakdown of what is copied, ported, and original.
