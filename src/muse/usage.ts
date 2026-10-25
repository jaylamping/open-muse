import type { Logger } from "../config.js";

/** The account's subscription usage: the 5h-class window and weekly percentages. */
export interface SubscriptionUsage {
  observedAtMs: number;
  tier: string;
  weekly: { resetsAtMs: number; usedPercent: number };
  window: { resetsAtMs: number; usedPercent: number; windowDurationMins?: number };
}

type UsageHost = {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

/**
 * Read the host's last-observed subscription usage (`usage/read`). Returns null
 * when the host observed nothing yet (fresh host, no turn run) or the call
 * fails: usage display must never break the request it accompanies.
 */
/**
 * Merge per-host observations: the quota is account-wide, but each host only
 * sees the turns it served. Freshest observation wins; a one-sided null is fine.
 */
export function pickUsage(a: SubscriptionUsage | null, b: SubscriptionUsage | null): SubscriptionUsage | null {
  if (a && b) return a.observedAtMs >= b.observedAtMs ? a : b;
  return a ?? b;
}

export async function readUsage(host: UsageHost, log: Logger): Promise<SubscriptionUsage | null> {
  try {
    const result = await host.request("usage/read", {});
    const u = (result as { usage?: unknown }).usage as Record<string, any> | undefined;
    if (!u || typeof u !== "object") return null;
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const windowPercent = num(u.window?.usedPercent);
    const weeklyPercent = num(u.weekly?.usedPercent);
    const windowReset = num(u.window?.resetsAtMs);
    const weeklyReset = num(u.weekly?.resetsAtMs);
    if (windowPercent === undefined || weeklyPercent === undefined || windowReset === undefined || weeklyReset === undefined) {
      return null;
    }
    return {
      observedAtMs: num(u.observedAtMs) ?? Date.now(),
      tier: typeof u.tier === "string" ? u.tier : "",
      weekly: { resetsAtMs: weeklyReset, usedPercent: weeklyPercent },
      window: {
        resetsAtMs: windowReset,
        usedPercent: windowPercent,
        ...(num(u.window?.windowDurationMins) !== undefined ? { windowDurationMins: num(u.window?.windowDurationMins) } : {}),
      },
    };
  } catch (error) {
    log.debug("usage/read skipped:", error instanceof Error ? error.message : error);
    return null;
  }
}
