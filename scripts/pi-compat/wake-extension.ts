// Stands in for Parley or a background-task notification: starts a primary run
// with no user input, the way those extensions do.
export default function (pi: any) {
  pi.on("session_start", () => {
    if (process.env.INBOX_PROBE_WAKE !== "1") return;
    setTimeout(() => pi.sendMessage({ customType: "peer_message", content: "PEER-WAKE: a colleague sent you something", display: true }, { triggerTurn: true }), 1500);
  });
}
