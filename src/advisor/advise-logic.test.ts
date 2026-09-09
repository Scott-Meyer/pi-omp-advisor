import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdvisorDeliveryChannel, type AdvisorSeverity } from "./advise-logic.ts";

const idle = { streaming: false, aborting: false, autoResumeSuppressed: false, terminalAnswerNoQueuedWork: true };
const severities: (AdvisorSeverity | undefined)[] = [undefined, "nit", "concern", "blocker"];

test("ordinary late advice stays dismissible, including default-severity nits", () => {
  for (const severity of [undefined, "nit", "concern"] as const) {
    assert.equal(resolveAdvisorDeliveryChannel({ ...idle, severity, interruptImmuneTurnActive: true }), "preserve", String(severity));
  }
});

test("all advice is preserved while aborting or after a latched stop", () => {
  for (const severity of severities) {
    for (const state of [
      { ...idle, autoResumeSuppressed: true },
      { ...idle, streaming: true, aborting: true, autoResumeSuppressed: true },
      { ...idle, streaming: true, aborting: true },
    ]) assert.equal(resolveAdvisorDeliveryChannel({ ...state, severity }), "preserve", String(severity));
  }
});

test("healthy active-run advice keeps its existing routing", () => {
  for (const autoResumeSuppressed of [false, true]) {
    for (const severity of severities) {
      assert.equal(resolveAdvisorDeliveryChannel({ ...idle, streaming: true, autoResumeSuppressed, severity }),
        severity === "concern" || severity === "blocker" ? "steer" : "aside");
    }
  }
});

test("an unsuppressed blocker remains the natural-completion exception", () => {
  assert.equal(resolveAdvisorDeliveryChannel({ ...idle, severity: "blocker" }), "steer");
  assert.equal(resolveAdvisorDeliveryChannel({ ...idle, severity: "blocker", preserveOnly: true }), "preserve");
});
