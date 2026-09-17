#!/usr/bin/env python3
import os
import re
import sys
import time
from pathlib import Path

import pexpect

if len(sys.argv) != 4:
    raise SystemExit("usage: tui-command-probe.py <omp> <cwd> <artifact-prefix>")

omp, cwd, prefix = sys.argv[1:]
raw_path = Path(prefix + ".raw")
text_path = Path(prefix + ".txt")
child_env = os.environ.copy()
child_env["OMP_SKIP_SETUP"] = "1"
child = pexpect.spawn(
    omp,
    ["--model", "compat/compat-model", "--cwd", cwd, "--no-session"],
    env=child_env,
    encoding=None,
    dimensions=(42, 150),
    timeout=8,
)

def wait_for_output_quiet(child: pexpect.spawn, quiet_seconds: float = 0.1) -> None:
    # expect() can leave already-read repaint bytes in its search buffer. Drop
    # those only after they have been recorded in logfile_read, then keep
    # draining the PTY until the renderer has been quiet for one interval.
    child.buffer = b""
    while True:
        try:
            child.read_nonblocking(size=4096, timeout=quiet_seconds)
        except pexpect.TIMEOUT:
            return

with raw_path.open("wb") as log:
    child.logfile_read = log
    # OMP's animated welcome screen consumes the first Enter as "skip". Wait
    # for its explicit affordance rather than racing startup in a fast PTY.
    try:
        child.expect(b"press enter to skip", timeout=8)
        child.send(b"\r")
    except pexpect.TIMEOUT:
        pass
    # Keep draining the PTY until the stable post-splash editor is painted.
    child.expect(b"Tip:", timeout=8)
    # The stable editor leaves the cursor at column 4; the row varies when an
    # extension adds a status/widget line. Unlike screen text, this repaint
    # marker is emitted after welcome content.
    child.expect(re.compile(rb"\x1b\[\d+;4H"), timeout=8)
    # Prove the command was registered before InteractiveMode snapshotted its
    # slash commands: a prefix plus Tab must complete the namespaced command.
    child.send(b"/pi-ad")
    child.expect(b"pi-advisor  Open pi-omp-advisor", timeout=8)
    child.send(b"\t")
    child.send(b" status")
    # Wait until the completion menu finishes painting before dismissing it.
    # Otherwise its trailing cursor-show bytes can be mistaken for Escape's
    # repaint and Escape+Enter can reach the input parser as Alt+Enter.
    child.expect(b"Show runtime, model, backlog, and queue state", timeout=8)
    wait_for_output_quiet(child)
    child.send(b"\x1b")
    child.expect_exact(b"\x1b[?25h\x1b[?7h", timeout=8)
    child.send(b"\r")
    try:
        child.expect(b"extension-sentinel", timeout=10)
    except pexpect.TIMEOUT:
        # Preserve the full artifact; the assertions below report the missing
        # command result after a graceful exit attempt.
        pass
    # Exercise actual note rendering too. The ordinary nit is preserved after
    # the first completed response and is released above the next nonempty
    # user prompt (OMP has no empty-Enter editor hook).
    child.send(b"Reply exactly PRIMARY_COMPAT_OK.\r")
    child.expect(b"PRIMARY_COMPAT_OK", timeout=12)
    child.expect(b"Advisor inbox", timeout=12)
    child.send(b"Continue with another short reply.\r")
    child.expect(b"OMP extension sentinel", timeout=12)
    wait_for_output_quiet(child, 0.2)
    child.sendcontrol("c")
    time.sleep(0.2)
    child.sendcontrol("c")
    try:
        child.expect(pexpect.EOF, timeout=8)
    except pexpect.TIMEOUT:
        child.sendcontrol("d")
        try:
            child.expect(pexpect.EOF, timeout=3)
        except pexpect.TIMEOUT:
            child.terminate(force=True)
child.close()

raw = raw_path.read_bytes().decode("utf-8", errors="replace")
# CSI, OSC, and a few single-character terminal controls. Preserve ordinary
# text and newlines so command/status evidence remains readable.
text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", raw)
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
text = re.sub(r"\x1b[@-_]", "", text)
text = text.replace("\r", "")
text_path.write_text(text)

required = [
    "pi-omp-advisor: extension-sentinel · compat/compat-model",
    "extension-sentinel · compat/compat-model: running",
    "caught up",
    "Advisor · extension-sentinel · compat/compat-model",
    "MODEL  extension-sentinel · compat/compat-model",
    "OMP extension sentinel",
]
missing = [needle for needle in required if needle not in text]
print(f"exitstatus={child.exitstatus} signalstatus={child.signalstatus}")
print(f"raw={raw_path}")
print(f"text={text_path}")
print(f"missing={missing}")
if missing:
    raise SystemExit(1)
