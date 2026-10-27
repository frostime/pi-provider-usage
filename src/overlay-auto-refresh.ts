export const DEFAULT_REFRESH_MINUTES = 5;
// Node timers overflow above 2^31 - 1 milliseconds.
export const MAX_REFRESH_MINUTES = Math.floor(2_147_483_647 / 60_000);
export const USAGE_SETTINGS_KEY = "npm:@frostime/pi-provider-usage";

export interface OverlayAutoRefresh {
  enabled: boolean;
  minutes: number;
}

export type AutoRefreshSetting = "on" | "off" | number;

export function parseAutoRefreshSetting(value: unknown): AutoRefreshSetting | undefined {
  if (value === "on" || value === "off") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REFRESH_MINUTES) {
    return value;
  }
  return undefined;
}

export function applyAutoRefreshSetting(
  setting: AutoRefreshSetting,
  previous: OverlayAutoRefresh = { enabled: false, minutes: DEFAULT_REFRESH_MINUTES },
): OverlayAutoRefresh {
  return {
    enabled: setting !== "off",
    minutes: typeof setting === "number" ? setting : previous.minutes,
  };
}

export function readAutoRefreshDefault(settings: unknown): {
  preference: OverlayAutoRefresh;
  invalid: boolean;
} {
  const namespace = settings && typeof settings === "object"
    ? (settings as Record<string, unknown>)[USAGE_SETTINGS_KEY]
    : undefined;
  if (namespace === undefined) return { preference: applyAutoRefreshSetting("off"), invalid: false };
  if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) {
    return { preference: applyAutoRefreshSetting("off"), invalid: true };
  }
  const value = (namespace as Record<string, unknown>).autoRefreshOverlay;
  const setting = parseAutoRefreshSetting(value);
  return {
    preference: applyAutoRefreshSetting(setting ?? "off"),
    invalid: value !== undefined && setting === undefined,
  };
}
