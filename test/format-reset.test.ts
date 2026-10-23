import assert from "node:assert/strict";
import { test } from "vitest";
import { formatUsageReport } from "../src/format.js";
import type { UsageReport } from "../src/types.js";

function report(resetsAt: number): UsageReport {
  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    capturedAt: 0,
    source: "opencode-go",
    semantics: { kind: "consumer-subscription", label: "OpenCode Zen plan usage" },
    buckets: [{ id: "rolling", label: "Rolling window", unit: "percent", used: 4, remaining: 96, resetsAt }],
    metrics: [],
  };
}

function resetText(epochSeconds: number): string | undefined {
  return formatUsageReport(report(epochSeconds), "current").match(/\(resets ([^)]+)\)/)?.[1];
}

test("formats reset times compactly instead of using a locale month name", () => {
  const today = new Date();
  today.setHours(12, 34, 0, 0);
  assert.equal(resetText(today.getTime() / 1000), "12:34");

  const later = new Date(today);
  later.setDate(later.getDate() + 1);
  const date = `${pad2(later.getMonth() + 1)}-${pad2(later.getDate())}`;
  const year = later.getFullYear() === today.getFullYear() ? "" : `${later.getFullYear()}-`;
  assert.equal(resetText(later.getTime() / 1000), `${year}${date} 12:34`);

  const nextYear = new Date(today.getFullYear() + 1, 0, 3, 12, 34);
  assert.equal(resetText(nextYear.getTime() / 1000), `${nextYear.getFullYear()}-01-03 12:34`);
});

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
