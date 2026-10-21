import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../config.js";
import type { MuseHost } from "./host.js";

/** Plan usage as Muse reports it (`usage/changed` params, `usage/read` result's `usage`). Missing fields are left out. */
export interface PlanUsage {
  tier?: string;
  window?: { usedPercent?: number; windowDurationMins?: number; resetsAtMs?: number };
  weekly?: { usedPercent?: number; resetsAtMs?: number };
  observedAtMs?: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function pick<K extends string>(source: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined {
  if (!source || typeof source !== "object") return undefined;
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = num((source as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep only the documented usage fields, so nothing else the host sends ends up on disk. */
export function planUsage(raw: unknown): PlanUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const usage: PlanUsage = {};
  if (typeof r.tier === "string") usage.tier = r.tier;
  const window = pick(r.window, ["usedPercent", "windowDurationMins", "resetsAtMs"] as const);
  if (window) usage.window = window;
  const weekly = pick(r.weekly, ["usedPercent", "resetsAtMs"] as const);
  if (weekly) usage.weekly = weekly;
  const observedAtMs = num(r.observedAtMs);
  if (observedAtMs !== undefined) usage.observedAtMs = observedAtMs;
  return usage.window || usage.weekly ? usage : undefined;
}

/** Write the file atomically (temp file + rename) so readers never see half of it. */
export function writeUsageFile(file: string, usage: PlanUsage): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...usage, writtenAtMs: Date.now() })}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * Mirrors the plan usage `muse serve` reports into a small JSON file, for status bars and
 * other tools that want to show it. Muse pushes `usage/changed` when the numbers change;
 * after the first finished turn we also ask once with `usage/read`, in case that push came
 * before we were listening.
 */
export class UsageFile {
  #file: string;
  #host: MuseHost;
  #log: Logger;
  #lastObserved = -1;
  #asked = false;

  constructor(file: string, host: MuseHost, log: Logger) {
    this.#file = file;
    this.#host = host;
    this.#log = log;
    host.subscribe((n) => {
      if (n.method === "usage/changed") this.#record(n.params);
      // A new `muse serve` starts with no usage of its own; ask again after its first turn.
      else if (n.method === "open-muse/hostExited") this.#asked = false;
    });
  }

  /** Call after a turn finished without error. */
  afterTurn(): void {
    if (this.#asked) return;
    this.#asked = true;
    this.#host
      .request("usage/read", {})
      .then((result) => this.#record(result.usage))
      .catch((error) => this.#log.debug("usage/read failed:", error instanceof Error ? error.message : error));
  }

  #record(raw: unknown): void {
    const usage = planUsage(raw);
    if (!usage) return;
    // A read can come back after a newer push; keep the newest observation.
    if (usage.observedAtMs !== undefined && usage.observedAtMs < this.#lastObserved) return;
    this.#lastObserved = usage.observedAtMs ?? this.#lastObserved;
    try {
      writeUsageFile(this.#file, usage);
    } catch (error) {
      this.#log.debug("could not write usage file:", error instanceof Error ? error.message : error);
    }
  }
}
