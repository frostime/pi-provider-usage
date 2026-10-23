import assert from "node:assert/strict";
import { test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatProviderStates } from "../src/format.js";
import type { ProviderUsageState } from "../src/types.js";

function ready(providerId: string, providerName: string): ProviderUsageState {
  return {
    status: "ready",
    providerId,
    providerName,
    displayState: "configured",
    report: {
      providerId,
      providerName,
      capturedAt: 0,
      source: "test",
      semantics: { kind: "api-key", label: "Test usage" },
      buckets: [],
      metrics: [{ id: "m", label: "Metric", value: 1 }],
    },
  };
}

test("panel sections start with a full-width title rule", () => {
  const text = formatProviderStates([ready("a", "Alpha"), ready("b", "Beta")], { width: 60 });
  const rules = text.split("\n").filter((line) => line.includes("Usage · Configured"));
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert.equal(visibleWidth(rule), 60);
    assert.match(rule, /^── .+ ─+$/);
  }
  // The rule replaces the plain heading instead of repeating it.
  assert.equal(text.match(/Alpha Usage · Configured/g)?.length, 1);
});

test("print output keeps the plain heading and no rule", () => {
  const text = formatProviderStates([ready("a", "Alpha")]);
  assert.match(text, /^Alpha Usage · Configured$/m);
  assert.doesNotMatch(text, /── /);
});

test("decorates the rule through the supplied style hook", () => {
  const text = formatProviderStates([ready("a", "Alpha")], {
    width: 40,
    decorateSection: (line) => `[${line}]`,
  });
  assert.match(text, /^\[── Alpha Usage · Configured ─+]$/m);
});
