import type { ProviderUsageState, UsageBucket, UsageDisplayState, UsageReport } from "./types.js";

const BAR_SEGMENTS = 20;
const VALUE_COLUMN = 29;

export function formatUsageReport(report: UsageReport, displayState: UsageDisplayState): string {
  const stateLabel = displayState === "current" ? "Current" : "Configured";
  const title =
    report.providerId === "baseten"
      ? "Baseten Model APIs Spend"
      : report.providerId === "deepseek"
        ? "DeepSeek API Balance"
        : report.providerId === "fireworks"
          ? "Fireworks API Spend"
          : report.providerId === "vercel-ai-gateway"
            ? "Vercel AI Gateway Credits"
            : report.providerId === "moonshotai" || report.providerId === "moonshotai-cn"
              ? `${report.providerName} Balance`
              : report.providerId === "minimax" || report.providerId === "minimax-cn"
                ? report.source === "minimax-account-balance"
                  ? `${report.providerName} API Balance`
                  : `${report.providerName} Token Plan`
                : report.source === "openai-chatgpt-auth"
                  ? `${report.providerName} ChatGPT Plan Status`
                  : `${report.providerName} Usage`;
  const lines = [`${title} · ${stateLabel}`];
  if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
  lines.push(`Semantics: ${report.semantics.label}`, "");

  if (report.providerId === "baseten") formatBasetenReport(lines, report);
  else if (report.providerId === "openai-codex") formatCodexReport(lines, report);
  else if (report.providerId === "deepseek") formatDeepSeekReport(lines, report);
  else if (report.providerId === "fireworks") formatFireworksReport(lines, report);
  else if (report.providerId === "vercel-ai-gateway") formatVercelAIGatewayReport(lines, report);
  else if (report.providerId === "github-copilot") formatGitHubCopilotReport(lines, report);
  else if (report.providerId === "openrouter") formatOpenRouterReport(lines, report);
  else if (report.providerId === "opencode-go") formatOpenCodeZenReport(lines, report);
  else if (report.providerId === "kimi-coding") formatKimiCodingReport(lines, report);
  else if (report.providerId === "moonshotai" || report.providerId === "moonshotai-cn") {
    formatMoonshotReport(lines, report);
  } else if (report.providerId === "minimax" || report.providerId === "minimax-cn") {
    formatMiniMaxReport(lines, report);
  } else if (report.providerId === "xai") formatXaiReport(lines, report);
  else if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
    formatZaiReport(lines, report);
  } else formatGenericReport(lines, report);

  if (report.notes) {
    for (const note of report.notes) lines.push(note);
  }
  return lines.join("\n").trimEnd();
}

export function formatProviderStates(states: readonly ProviderUsageState[]): string {
  return states
    .map((state) => {
      if (state.status === "ready") return formatUsageReport(state.report, state.displayState);
      const label = state.displayState === "current" ? "Current" : "Configured";
      if (state.status === "selection-required") {
        return `${state.providerName} · ${label}\nSelection required: multiple ${state.pluralLabel} are available. Selecting a billing ${state.singularLabel} is not supported in this version.`;
      }
      const status =
        state.status === "auth-unavailable"
          ? "Authentication unavailable"
          : state.status === "unsupported"
            ? "Unsupported"
            : "Query failed";
      return `${state.providerName} · ${label}\n${status}: ${state.message}`;
    })
    .join("\n\n");
}

function formatBasetenReport(lines: string[], report: UsageReport): void {
  lines.push(`${"Spend window:".padEnd(VALUE_COLUMN)}Last 30 days`);
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}USD ${metric.value}`);
  }
}

function formatCodexReport(lines: string[], report: UsageReport): void {
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    const group = bucket.groupId ?? bucket.id;
    if (group !== previousGroup && group !== "codex") {
      lines.push(`${bucket.groupLabel ?? group} limit:`);
    }
    previousGroup = group;
    const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
    const label = `${formatWindowLabel(bucket.windowMinutes, fallback)} limit:`;
    lines.push(`${label.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
  }
  for (const metric of report.metrics) {
    if (metric.id === "reset-credits") {
      lines.push(`${"Usage limit resets:".padEnd(VALUE_COLUMN)}${metric.value} available`);
    } else if (metric.id === "credits") {
      lines.push(`${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`);
    }
  }
}

function formatDeepSeekReport(lines: string[], report: UsageReport): void {
  const availability = report.metrics.find((metric) => metric.id === "api-availability");
  lines.push(
    `${"API calls:".padEnd(VALUE_COLUMN)}${availability?.value === "available" ? "Available" : "Unavailable"}`,
  );
  for (const currency of ["CNY", "USD"]) {
    const metrics = report.metrics.filter((metric) => metric.currency === currency);
    if (metrics.length === 0) continue;
    lines.push("", `${currency} balance:`);
    for (const metric of metrics) {
      lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${currency} ${metric.value}`);
    }
  }
}

function formatFireworksReport(lines: string[], report: UsageReport): void {
  lines.push(`${"Spend window:".padEnd(VALUE_COLUMN)}Last 30 days (rated)`);
  for (const currency of fireworksCurrencies(report)) {
    lines.push("", `${currency} rated spend:`);
    for (const metric of report.metrics) {
      if (metric.currency !== currency) continue;
      lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${currency} ${metric.value}`);
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

function formatVercelAIGatewayReport(lines: string[], report: UsageReport): void {
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}USD ${metric.value}`);
  }
}

function formatGitHubCopilotReport(lines: string[], report: UsageReport): void {
  const quota = findGitHubCopilotQuota(report);
  if (!quota || quota.limit === undefined || quota.remaining === undefined) {
    lines.push(`${`${quota?.label ?? "Copilot quota"}:`.padEnd(VALUE_COLUMN)}unlimited`);
    return;
  }
  const percent = percentRemaining(quota);
  const reset = quota.resetsAt ? ` (resets ${formatReset(quota.resetsAt)})` : "";
  lines.push(
    `${`${quota.label}:`.padEnd(VALUE_COLUMN)}${quota.remaining} of ${quota.limit} left · ${percent}%${reset}`,
  );
  const overage = report.metrics.find((metric) => metric.id === "overage-used");
  if (typeof overage?.value === "number" && overage.value > 0) {
    lines.push(`${"Additional usage:".padEnd(VALUE_COLUMN)}${overage.value} ${quota.label}`);
  }
}

function findGitHubCopilotQuota(report: UsageReport): UsageBucket | undefined {
  return report.buckets.find((bucket) => ["ai-credits", "premium-requests", "chat-requests"].includes(bucket.id));
}

function percentRemaining(bucket: UsageBucket): number {
  if (!bucket.limit || bucket.remaining === undefined) return 0;
  return Math.round(clampPercent((bucket.remaining / bucket.limit) * 100));
}

function formatOpenRouterReport(lines: string[], report: UsageReport): void {
  const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
  if (limit) {
    const period = limit.period ? ` (${limit.period})` : "";
    const value =
      limit.remaining === undefined
        ? `${formatUsd(limit.limit ?? 0)} cap; remaining unavailable`
        : `${formatUsd(limit.remaining)} of ${formatUsd(limit.limit ?? 0)} left`;
    lines.push(`${`Key limit${period}:`.padEnd(VALUE_COLUMN)}${value}`);
  }
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`);
  }
}

function formatOpenCodeZenReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent" && bucket.used !== undefined) {
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
      continue;
    }
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    const used = bucket.used ?? "unavailable";
    lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${used}% used${reset}`);
  }
}

function formatKimiCodingReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    if (bucket.unit === "percent") {
      const remaining = bucket.remaining === undefined ? undefined : Math.round(clampPercent(bucket.remaining));
      const value =
        bucket.used === undefined || remaining === undefined
          ? "unavailable"
          : `${100 - remaining}% used · ${remaining}% left`;
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}${reset}`);
      continue;
    }
    if (bucket.used === undefined || bucket.limit === undefined) {
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}unavailable${reset}`);
      continue;
    }
    lines.push(
      `${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${bucket.used} of ${bucket.limit} used · ${percentRemaining(bucket)}% left${reset}`,
    );
  }
  const balance = report.metrics.find((metric) => metric.id === "booster-balance");
  const total = report.metrics.find((metric) => metric.id === "booster-total");
  const monthlyUsed = report.metrics.find((metric) => metric.id === "booster-monthly-used");
  const monthlyLimit = report.metrics.find((metric) => metric.id === "booster-monthly-limit");
  if (!balance && !monthlyUsed && !monthlyLimit) return;
  lines.push("", "Extra usage wallet:");
  if (balance) {
    const totalSuffix = total ? ` of ${formatCurrencyMetric(total)}` : "";
    lines.push(`${"Balance:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(balance)}${totalSuffix}`);
  }
  if (monthlyUsed) {
    lines.push(`${"Used this month:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyUsed)}`);
  }
  if (monthlyLimit) {
    lines.push(`${"Monthly limit:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyLimit)}`);
  }
}

function formatMoonshotReport(lines: string[], report: UsageReport): void {
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${metric.currency} ${metric.value}`);
  }
}

function formatMiniMaxReport(lines: string[], report: UsageReport): void {
  if (report.source === "minimax-account-balance") {
    for (const metric of report.metrics) {
      lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${metric.currency} ${metric.value}`);
    }
    return;
  }
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    if (bucket.groupId !== previousGroup) lines.push(`${bucket.groupLabel ?? "Token Plan"}:`);
    previousGroup = bucket.groupId;
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    const value =
      bucket.period === "unlimited"
        ? "unlimited"
        : bucket.unit === "percent" && bucket.remaining !== undefined
          ? `${bucket.remaining}% remaining${reset}`
          : bucket.limit !== undefined && bucket.remaining !== undefined
            ? `${bucket.remaining} of ${bucket.limit} left · ${percentRemaining(bucket)}%${reset}`
            : "unavailable";
    lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}`);
  }
}

function formatCurrencyMetric(metric: UsageReport["metrics"][number]): string {
  if (typeof metric.value !== "number") return String(metric.value);
  if (!metric.currency) return "unavailable";
  if (metric.currency === "USD") return `$${metric.value.toFixed(2)}`;
  if (metric.currency === "CNY") return `¥${metric.value.toFixed(2)}`;
  return `${metric.value.toFixed(2)} ${metric.currency}`;
}

function formatXaiReport(lines: string[], report: UsageReport): void {
  const included = report.buckets.find((bucket) => bucket.id === "included-allowance");
  if (included) {
    let value = "unavailable";
    if (included.unit === "percent" && included.used !== undefined) {
      value = formatPercentBar(included);
    } else if (included.used !== undefined) {
      value = `${formatUsd(included.used)} used`;
      if (included.limit !== undefined) value += ` of ${formatUsd(included.limit)}`;
    } else if (included.limit !== undefined) {
      value = `usage unavailable · ${formatUsd(included.limit)} limit`;
    }
    const period = included.period ? ` · ${included.period}` : "";
    const reset = included.resetsAt ? ` (resets ${formatReset(included.resetsAt)})` : "";
    lines.push(`${"Included allowance:".padEnd(VALUE_COLUMN)}${value}${period}${reset}`);
  }
  const onDemand = report.buckets.find((bucket) => bucket.id === "on-demand");
  if (onDemand) {
    let value = onDemand.used === undefined ? "usage unavailable" : `${formatUsd(onDemand.used)} used`;
    if (onDemand.limit !== undefined) value += ` of ${formatUsd(onDemand.limit)} cap`;
    lines.push(`${"On-demand usage:".padEnd(VALUE_COLUMN)}${value}`);
  }
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`);
  }
}

function formatZaiReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent" && bucket.used !== undefined) {
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
      continue;
    }
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    let value = "unavailable";
    if (bucket.used !== undefined && bucket.limit !== undefined) {
      value = `${bucket.used} of ${bucket.limit} used`;
      if (bucket.remaining !== undefined) value += ` · ${bucket.remaining} left`;
    } else if (bucket.used !== undefined) {
      value = `${bucket.used} used`;
    } else if (bucket.remaining !== undefined) {
      value = `${bucket.remaining} left`;
    }
    lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}${reset}`);
  }
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`);
  }
}

function formatGenericReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    lines.push(
      `${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit)}`,
    );
  }
  for (const metric of report.metrics) {
    lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`);
  }
}

function formatPercentBucket(bucket: UsageBucket): string {
  return `${formatPercentBar(bucket)}${bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : ""}`;
}

function formatPercentBar(bucket: UsageBucket): string {
  const remaining = clampPercent(bucket.remaining ?? 0);
  const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}] ${remaining.toFixed(0)}% left`;
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

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset.getMinutes().toString().padStart(2, "0")}`;
  const now = new Date();
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
