import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderUsageState, UsageBucket, UsageDisplayState, UsageReport } from "./types.js";

const MAX_BAR_CELLS = 14;
const MIN_BAR_CELLS = 8;
const MAX_LABEL_WIDTH = 20;
const MIN_LABEL_WIDTH = 10;
/** Columns a row needs besides the bar: label column, percent text, and reset note. */
const ROW_CHROME_WIDTH = 56;
/** The label column never takes more than this share of the available width. */
const LABEL_WIDTH_SHARE = 0.35;

/** Width budget for panel rendering; omit it to render unconstrained text. */
export interface UsageFormatOptions {
  width?: number;
  /** Decorates a section title rule, for example with the panel's accent color. */
  decorateSection?: (line: string) => string;
}

/** One field row, or a plain line such as a provider title or section heading. */
interface UsageRow {
  label?: string;
  text: string;
  /** Trailing reset text, composed with the value so both share one line. */
  note?: string;
}

export function formatUsageReport(
  report: UsageReport,
  displayState: UsageDisplayState,
  options: UsageFormatOptions = {},
): string {
  const rows = reportRows(report, displayState, barCellsFor(options.width));
  return renderRows(rows, labelWidthFor(rows, options.width), options.width);
}

export function formatProviderStates(
  states: readonly ProviderUsageState[],
  options: UsageFormatOptions = {},
): string {
  const barCells = barCellsFor(options.width);
  const sections = states.map((state) => stateRows(state, barCells));
  // One label column across providers keeps the "all" panel aligned.
  const labelWidth = labelWidthFor(sections.flat(), options.width);
  return sections
    .map((rows) => renderSection(rows, labelWidth, options))
    .join("\n\n");
}

function stateRows(state: ProviderUsageState, barCells: number): UsageRow[] {
  if (state.status === "ready") return reportRows(state.report, state.displayState, barCells);
  const label = state.displayState === "current" ? "Current" : "Configured";
  if (state.status === "selection-required") {
    return [
      { text: `${state.providerName} · ${label}` },
      {
        text: `Selection required: multiple ${state.pluralLabel} are available. Selecting a billing ${state.singularLabel} is not supported in this version.`,
      },
    ];
  }
  const status =
    state.status === "auth-unavailable"
      ? "Authentication unavailable"
      : state.status === "unsupported"
        ? "Unsupported"
        : "Query failed";
  return [{ text: `${state.providerName} · ${label}` }, { text: `${status}: ${state.message}` }];
}

function reportRows(report: UsageReport, displayState: UsageDisplayState, barCells: number): UsageRow[] {
  const stateLabel = displayState === "current" ? "Current" : "Configured";
  const rows: UsageRow[] = [{ text: `${reportTitle(report)} · ${stateLabel}` }];
  if (report.accountLabel) rows.push({ text: `Account: ${report.accountLabel}` });
  rows.push({ text: `Semantics: ${report.semantics.label}` }, { text: "" });

  if (report.providerId === "baseten") formatBasetenReport(rows, report);
  else if (report.providerId === "openai-codex") formatCodexReport(rows, report, barCells);
  else if (report.providerId === "deepseek") formatDeepSeekReport(rows, report);
  else if (report.providerId === "fireworks") formatFireworksReport(rows, report);
  else if (report.providerId === "vercel-ai-gateway") formatVercelAIGatewayReport(rows, report);
  else if (report.providerId === "github-copilot") formatGitHubCopilotReport(rows, report);
  else if (report.providerId === "openrouter") formatOpenRouterReport(rows, report);
  else if (report.providerId === "opencode-go") formatOpenCodeZenReport(rows, report, barCells);
  else if (report.providerId === "kimi-coding") formatKimiCodingReport(rows, report);
  else if (report.providerId === "moonshotai" || report.providerId === "moonshotai-cn") {
    formatMoonshotReport(rows, report);
  } else if (report.providerId === "minimax" || report.providerId === "minimax-cn") {
    formatMiniMaxReport(rows, report);
  } else if (report.providerId === "xai") formatXaiReport(rows, report, barCells);
  else if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
    formatZaiReport(rows, report, barCells);
  } else formatGenericReport(rows, report);

  if (report.notes) {
    for (const note of report.notes) rows.push({ text: note });
  }
  return rows;
}

function reportTitle(report: UsageReport): string {
  if (report.providerId === "baseten") return "Baseten Model APIs Spend";
  if (report.providerId === "deepseek") return "DeepSeek API Balance";
  if (report.providerId === "fireworks") return "Fireworks API Spend";
  if (report.providerId === "vercel-ai-gateway") return "Vercel AI Gateway Credits";
  if (report.providerId === "moonshotai" || report.providerId === "moonshotai-cn") {
    return `${report.providerName} Balance`;
  }
  if (report.providerId === "minimax" || report.providerId === "minimax-cn") {
    return report.source === "minimax-account-balance"
      ? `${report.providerName} API Balance`
      : `${report.providerName} Token Plan`;
  }
  if (report.source === "openai-chatgpt-auth") return `${report.providerName} ChatGPT Plan Status`;
  return `${report.providerName} Usage`;
}

function formatBasetenReport(rows: UsageRow[], report: UsageReport): void {
  rows.push({ label: "Spend window:", text: "Last 30 days" });
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: `USD ${metric.value}` });
  }
}

function formatCodexReport(rows: UsageRow[], report: UsageReport, barCells: number): void {
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    const group = bucket.groupId ?? bucket.id;
    if (group !== previousGroup && group !== "codex") {
      rows.push({ text: `${bucket.groupLabel ?? group} limit:` });
    }
    previousGroup = group;
    const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
    rows.push({
      label: `${formatWindowLabel(bucket.windowMinutes, fallback)} limit:`,
      text: formatPercentBar(bucket, barCells),
      ...resetNote(bucket),
    });
  }
  for (const metric of report.metrics) {
    if (metric.id === "reset-credits") {
      rows.push({ label: "Usage limit resets:", text: `${metric.value} available` });
    } else if (metric.id === "credits") {
      rows.push({ label: "Credits:", text: formatMetricValue(metric.value, metric.unit) });
    }
  }
}

function formatDeepSeekReport(rows: UsageRow[], report: UsageReport): void {
  const availability = report.metrics.find((metric) => metric.id === "api-availability");
  rows.push({
    label: "API calls:",
    text: availability?.value === "available" ? "Available" : "Unavailable",
  });
  for (const currency of ["CNY", "USD"]) {
    const metrics = report.metrics.filter((metric) => metric.currency === currency);
    if (metrics.length === 0) continue;
    rows.push({ text: "" }, { text: `${currency} balance:` });
    for (const metric of metrics) {
      rows.push({ label: `${metric.label}:`, text: `${currency} ${metric.value}` });
    }
  }
}

function formatFireworksReport(rows: UsageRow[], report: UsageReport): void {
  rows.push({ label: "Spend window:", text: "Last 30 days (rated)" });
  for (const currency of fireworksCurrencies(report)) {
    rows.push({ text: "" }, { text: `${currency} rated spend:` });
    for (const metric of report.metrics) {
      if (metric.currency !== currency) continue;
      rows.push({ label: `${metric.label}:`, text: `${currency} ${metric.value}` });
    }
  }
}

function fireworksCurrencies(report: UsageReport): string[] {
  const currencies: string[] = [];
  for (const metric of report.metrics) {
    if (!metric.currency || currencies.includes(metric.currency)) continue;
    currencies.push(metric.currency);
  }
  return currencies;
}

function formatVercelAIGatewayReport(rows: UsageRow[], report: UsageReport): void {
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: `USD ${metric.value}` });
  }
}

function formatGitHubCopilotReport(rows: UsageRow[], report: UsageReport): void {
  const quota = findGitHubCopilotQuota(report);
  if (!quota || quota.limit === undefined || quota.remaining === undefined) {
    rows.push({ label: `${quota?.label ?? "Copilot quota"}:`, text: "unlimited" });
    return;
  }
  const percent = percentRemaining(quota);
  rows.push({
    label: `${quota.label}:`,
    text: `${quota.remaining} of ${quota.limit} left · ${percent}%`,
    ...resetNote(quota),
  });
  const overage = report.metrics.find((metric) => metric.id === "overage-used");
  if (typeof overage?.value === "number" && overage.value > 0) {
    rows.push({ label: "Additional usage:", text: `${overage.value} ${quota.label}` });
  }
}

function findGitHubCopilotQuota(report: UsageReport): UsageBucket | undefined {
  return report.buckets.find((bucket) => ["ai-credits", "premium-requests", "chat-requests"].includes(bucket.id));
}

function percentRemaining(bucket: UsageBucket): number {
  if (!bucket.limit || bucket.remaining === undefined) return 0;
  return Math.round(clampPercent((bucket.remaining / bucket.limit) * 100));
}

function formatOpenRouterReport(rows: UsageRow[], report: UsageReport): void {
  const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
  if (limit) {
    const period = limit.period ? ` (${limit.period})` : "";
    const value =
      limit.remaining === undefined
        ? `${formatUsd(limit.limit ?? 0)} cap; remaining unavailable`
        : `${formatUsd(limit.remaining)} of ${formatUsd(limit.limit ?? 0)} left`;
    rows.push({ label: `Key limit${period}:`, text: value });
  }
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: formatMetricValue(metric.value, metric.unit) });
  }
}

function formatOpenCodeZenReport(rows: UsageRow[], report: UsageReport, barCells: number): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent" && bucket.used !== undefined) {
      rows.push({ label: `${bucket.label}:`, text: formatPercentBar(bucket, barCells), ...resetNote(bucket) });
      continue;
    }
    const used = bucket.used ?? "unavailable";
    rows.push({ label: `${bucket.label}:`, text: `${used}% used`, ...resetNote(bucket) });
  }
}

function formatKimiCodingReport(rows: UsageRow[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent") {
      const remaining = bucket.remaining === undefined ? undefined : Math.round(clampPercent(bucket.remaining));
      const value =
        bucket.used === undefined || remaining === undefined
          ? "unavailable"
          : `${100 - remaining}% used · ${remaining}% left`;
      rows.push({ label: `${bucket.label}:`, text: value, ...resetNote(bucket) });
      continue;
    }
    if (bucket.used === undefined || bucket.limit === undefined) {
      rows.push({ label: `${bucket.label}:`, text: "unavailable", ...resetNote(bucket) });
      continue;
    }
    rows.push({
      label: `${bucket.label}:`,
      text: `${bucket.used} of ${bucket.limit} used · ${percentRemaining(bucket)}% left`,
      ...resetNote(bucket),
    });
  }
  const balance = report.metrics.find((metric) => metric.id === "booster-balance");
  const total = report.metrics.find((metric) => metric.id === "booster-total");
  const monthlyUsed = report.metrics.find((metric) => metric.id === "booster-monthly-used");
  const monthlyLimit = report.metrics.find((metric) => metric.id === "booster-monthly-limit");
  if (!balance && !monthlyUsed && !monthlyLimit) return;
  rows.push({ text: "" }, { text: "Extra usage wallet:" });
  if (balance) {
    const totalSuffix = total ? ` of ${formatCurrencyMetric(total)}` : "";
    rows.push({ label: "Balance:", text: `${formatCurrencyMetric(balance)}${totalSuffix}` });
  }
  if (monthlyUsed) {
    rows.push({ label: "Used this month:", text: formatCurrencyMetric(monthlyUsed) });
  }
  if (monthlyLimit) {
    rows.push({ label: "Monthly limit:", text: formatCurrencyMetric(monthlyLimit) });
  }
}

function formatMoonshotReport(rows: UsageRow[], report: UsageReport): void {
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: `${metric.currency} ${metric.value}` });
  }
}

function formatMiniMaxReport(rows: UsageRow[], report: UsageReport): void {
  if (report.source === "minimax-account-balance") {
    for (const metric of report.metrics) {
      rows.push({ label: `${metric.label}:`, text: `${metric.currency} ${metric.value}` });
    }
    return;
  }
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    if (bucket.groupId !== previousGroup) rows.push({ text: `${bucket.groupLabel ?? "Token Plan"}:` });
    previousGroup = bucket.groupId;
    const value =
      bucket.period === "unlimited"
        ? "unlimited"
        : bucket.unit === "percent" && bucket.remaining !== undefined
          ? `${bucket.remaining}% remaining`
          : bucket.limit !== undefined && bucket.remaining !== undefined
            ? `${bucket.remaining} of ${bucket.limit} left · ${percentRemaining(bucket)}%`
            : "unavailable";
    rows.push({ label: `${bucket.label}:`, text: value, ...resetNote(bucket) });
  }
}

function formatCurrencyMetric(metric: UsageReport["metrics"][number]): string {
  if (typeof metric.value !== "number") return String(metric.value);
  if (!metric.currency) return "unavailable";
  if (metric.currency === "USD") return `$${metric.value.toFixed(2)}`;
  if (metric.currency === "CNY") return `¥${metric.value.toFixed(2)}`;
  return `${metric.value.toFixed(2)} ${metric.currency}`;
}

function formatXaiReport(rows: UsageRow[], report: UsageReport, barCells: number): void {
  const included = report.buckets.find((bucket) => bucket.id === "included-allowance");
  if (included) {
    let value = "unavailable";
    if (included.unit === "percent" && included.used !== undefined) {
      value = formatPercentBar(included, barCells);
    } else if (included.used !== undefined) {
      value = `${formatUsd(included.used)} used`;
      if (included.limit !== undefined) value += ` of ${formatUsd(included.limit)}`;
    } else if (included.limit !== undefined) {
      value = `usage unavailable · ${formatUsd(included.limit)} limit`;
    }
    const period = included.period ? ` · ${included.period}` : "";
    rows.push({ label: "Included allowance:", text: `${value}${period}`, ...resetNote(included) });
  }
  const onDemand = report.buckets.find((bucket) => bucket.id === "on-demand");
  if (onDemand) {
    let value = onDemand.used === undefined ? "usage unavailable" : `${formatUsd(onDemand.used)} used`;
    if (onDemand.limit !== undefined) value += ` of ${formatUsd(onDemand.limit)} cap`;
    rows.push({ label: "On-demand usage:", text: value });
  }
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: formatMetricValue(metric.value, metric.unit) });
  }
}

function formatZaiReport(rows: UsageRow[], report: UsageReport, barCells: number): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent" && bucket.used !== undefined) {
      rows.push({ label: `${bucket.label}:`, text: formatPercentBar(bucket, barCells), ...resetNote(bucket) });
      continue;
    }
    let value = "unavailable";
    if (bucket.used !== undefined && bucket.limit !== undefined) {
      value = `${bucket.used} of ${bucket.limit} used`;
      if (bucket.remaining !== undefined) value += ` · ${bucket.remaining} left`;
    } else if (bucket.used !== undefined) {
      value = `${bucket.used} used`;
    } else if (bucket.remaining !== undefined) {
      value = `${bucket.remaining} left`;
    }
    rows.push({ label: `${bucket.label}:`, text: value, ...resetNote(bucket) });
  }
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: formatMetricValue(metric.value, metric.unit) });
  }
}

function formatGenericReport(rows: UsageRow[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    rows.push({
      label: `${bucket.label}:`,
      text: formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit),
    });
  }
  for (const metric of report.metrics) {
    rows.push({ label: `${metric.label}:`, text: formatMetricValue(metric.value, metric.unit) });
  }
}

function renderSection(rows: readonly UsageRow[], labelWidth: number, options: UsageFormatOptions): string {
  if (options.width === undefined) return renderRows(rows, labelWidth, options.width);
  // The first row is the provider heading; a full-width rule replaces it for panel output.
  const rule = sectionRule(rows[0]?.text ?? "", options.width);
  const painted = options.decorateSection ? options.decorateSection(rule) : rule;
  return `${painted}\n${renderRows(rows.slice(1), labelWidth, options.width)}`;
}

function sectionRule(title: string, width: number): string {
  const lead = `── ${title} `;
  const used = visibleWidth(lead);
  return used >= width ? truncateToWidth(lead, width) : `${lead}${"─".repeat(width - used)}`;
}

function renderRows(rows: readonly UsageRow[], labelWidth: number, width: number | undefined): string {
  const lines: string[] = [];
  for (const row of rows) {
    const gap =
      row.label === undefined
        ? ""
        : row.label.length >= labelWidth
          ? " "
          : " ".repeat(labelWidth - row.label.length);
    const main = `${row.label ?? ""}${gap}${row.text}`;
    const full = row.note === undefined ? main : `${main} (${row.note})`;
    if (width === undefined || visibleWidth(full) <= width) {
      lines.push(full);
      continue;
    }
    if (row.label === undefined) {
      lines.push(full);
      continue;
    }
    // Bar, percentage, and reset belong together: move the whole value below its label
    // rather than leaving the label with a dangling continuation line.
    lines.push(row.label);
    lines.push(`  ${row.note === undefined ? row.text : `${row.text} (${row.note})`}`);
  }
  return lines.join("\n").trimEnd();
}

function labelWidthFor(rows: readonly UsageRow[], width: number | undefined): number {
  let longest = 0;
  for (const row of rows) longest = Math.max(longest, row.label?.length ?? 0);
  const cap =
    width === undefined
      ? MAX_LABEL_WIDTH
      : clamp(Math.floor(width * LABEL_WIDTH_SHARE), MIN_LABEL_WIDTH, MAX_LABEL_WIDTH);
  return Math.min(longest + 2, cap);
}

function barCellsFor(width: number | undefined): number {
  if (width === undefined) return MAX_BAR_CELLS;
  return clamp(width - ROW_CHROME_WIDTH, MIN_BAR_CELLS, MAX_BAR_CELLS);
}

function resetNote(bucket: UsageBucket): Pick<UsageRow, "note"> {
  return bucket.resetsAt === undefined ? {} : { note: `resets ${formatReset(bucket.resetsAt)}` };
}

function formatPercentBar(bucket: UsageBucket, barCells: number): string {
  const remaining = clampPercent(bucket.remaining ?? 0);
  const filled = Math.round((remaining / 100) * barCells);
  return `[${"█".repeat(filled)}${"░".repeat(barCells - filled)}] ${remaining.toFixed(0)}% left`;
}

function formatWindowLabel(minutes: number | undefined, fallback: "5h" | "weekly"): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
    return capitalize(fallback);
  }
  if (minutes === 10_080) return "Weekly";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatMetricValue(value: number | string, unit: UsageBucket["unit"] | undefined): string {
  if (unit === "usd" && typeof value === "number") return formatUsd(value);
  return String(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Compact, locale-independent reset time: `HH:mm` today, `MM-DD HH:mm` otherwise. */
function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";
  const now = new Date();
  const time = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
  if (reset.toDateString() === now.toDateString()) return time;
  const date = `${pad2(reset.getMonth() + 1)}-${pad2(reset.getDate())}`;
  const year = reset.getFullYear() === now.getFullYear() ? "" : `${reset.getFullYear()}-`;
  return `${year}${date} ${time}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
