import fs from "node:fs";
import path from "node:path";
import type { MuseHost } from "./host.js";
import type { Logger, OpenMuseConfig } from "../config.js";

export interface MuseModel {
  id: string;
  name: string;
  context: number;
  output: number;
  efforts: string[];
  isDefault?: boolean;
  /** The effort the server applies when none is requested. */
  defaultEffort?: string;
}

/** The effort a turn will actually run with: requested, else the model's default, else unresolved. */
export function resolveEffort(models: MuseModel[], modelId: string | undefined, requested?: string): string {
  if (requested) return requested;
  return models.find((m) => m.id === modelId)?.defaultEffort ?? "default";
}

/** Used until `muse serve` reports the real catalog for this account (then cached). */
const ALL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const model = (id: string, efforts = ALL_EFFORTS): MuseModel => ({ id, name: id, context: 1_007_997, output: 128_000, efforts });
export const DEFAULT_MODELS: MuseModel[] = [
  { ...model("muse-wonder-1.0"), isDefault: true },
  model("muse-wonder-full-1.0"),
  model("muse-spark-1.3"),
  model("muse-spark-1.2", ALL_EFFORTS.slice(0, -1)),
];

/**
 * Derive a `-contributor` twin for every base model the server lists without
 * one. The server remains authoritative: entries it already lists are kept
 * untouched, so a future `muse-new-1.0` automatically gains a
 * `muse-new-1.0-contributor` twin without a code change.
 */
export function withContributorVariants(models: MuseModel[]): MuseModel[] {
  const ids = new Set(models.map((m) => m.id));
  const out = [...models];
  for (const m of models) {
    if (m.id.endsWith("-contributor")) continue;
    const twin = `${m.id}-contributor`;
    if (ids.has(twin)) continue;
    ids.add(twin);
    // The twin is named by its own id, so OpenCode shows exactly
    // `muse-spark-1.3-contributor` instead of `muse-spark-1.3 (<id>)`.
    out.push({ ...m, id: twin, name: twin, isDefault: false });
  }
  return out;
}

/** True for `-contributor` model ids, which run on the contributor host. */
export function isContributorModel(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.endsWith("-contributor");
}

/** Alphabetical by id, so each base model sits next to its `-contributor` twin. */
/**
 * Migrate cache entries written before twins were named by their own id:
 * `{ id: "X-contributor", name: "X" }` becomes `{ id: "X-contributor",
 * name: "X-contributor" }`, so the picker shows the friendly label instead
 * of `X (X-contributor)`. Entries the server genuinely labeled `X` are
 * unaffected in behavior: they still display through `displayName`.
 */
export function normalizeCachedModels(models: MuseModel[]): MuseModel[] {
  const suffix = "-contributor";
  return models.map((m) =>
    m.id.endsWith(suffix) && m.name === m.id.slice(0, -suffix.length) ? { ...m, name: m.id } : m,
  );
}

export function sortModels(models: MuseModel[]): MuseModel[] {
  return [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export class ModelCatalog {
  #host: MuseHost;
  #contributorHost?: MuseHost;
  #log: Logger;
  #file: string;
  #models: MuseModel[];
  #cachedAt = 0;
  #contributor: boolean;

  constructor(host: MuseHost, config: OpenMuseConfig, log: Logger, contributorHost?: MuseHost) {
    this.#host = host;
    this.#contributorHost = contributorHost;
    this.#log = log;
    this.#file = path.join(config.stateDir, "models.json");
    this.#contributor = config.contributor;
    const initial = normalizeCachedModels(this.#readCache() ?? DEFAULT_MODELS);
    this.#models = sortModels(this.#contributor ? withContributorVariants(initial) : initial);
  }

  get models(): MuseModel[] {
    return this.#models;
  }

  /** True when there is no cached catalog from `muse serve`, or it is more than a day old. */
  get stale(): boolean {
    return Date.now() - this.#cachedAt > 24 * 60 * 60 * 1000;
  }

  /** Ask `muse serve` for the account's catalog and cache it for the next OpenCode start. */
  async refresh(): Promise<MuseModel[]> {
    const listed = this.#parse((await this.#host.request("model/list", {})).models);
    if (listed.length === 0) return this.#models;
    // Contributor twins run on the contributor host, whose per-model defaults
    // can differ (e.g. spark-1.3 defaults to max there, high otherwise).
    let contribDefaults: Map<string, string> | undefined;
    if (this.#contributorHost && this.#contributor) {
      try {
        const rows = (await this.#contributorHost.request("model/list", {})).models;
        contribDefaults = new Map<string, string>();
        for (const r of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
          if (typeof r.modelId === "string" && typeof r.defaultReasoningEffort === "string") {
            contribDefaults.set(r.modelId, r.defaultReasoningEffort);
          }
        }
      } catch (error) {
        this.#log.debug("contributor catalog skipped:", error instanceof Error ? error.message : error);
      }
    }
    let models = this.#contributor ? withContributorVariants(listed) : listed;
    if (contribDefaults) {
      const suffix = "-contributor";
      models = models.map((m) => {
        // The contributor host lists base ids: look the twin's default up
        // under its base id.
        const d = isContributorModel(m.id) ? contribDefaults.get(m.id.slice(0, -suffix.length)) : undefined;
        return d !== undefined && d !== m.defaultEffort ? { ...m, defaultEffort: d } : m;
      });
    }
    models = sortModels(models);
    this.#models = models;
    this.#writeCache(models);
    return this.#models;
  }

  #parse(rows: unknown): MuseModel[] {
    return (Array.isArray(rows) ? (rows as Record<string, any>[]) : [])
      .filter((r) => typeof r.modelId === "string" && r.modelId)
      .map<MuseModel>((r) => ({
        id: r.modelId,
        name: typeof r.displayLabel === "string" && r.displayLabel ? r.displayLabel : r.modelId,
        context: typeof r.contextLimit === "number" ? r.contextLimit : 1_048_576,
        output: typeof r.outputLimit === "number" ? r.outputLimit : 131_072,
        efforts: Array.isArray(r.variants) ? r.variants.filter((v: unknown) => typeof v === "string" && v !== "none") : [],
        isDefault: r.isDefault === true,
        defaultEffort: typeof r.defaultReasoningEffort === "string" && r.defaultReasoningEffort ? r.defaultReasoningEffort : undefined,
      }));
  }

  /**
   * Refresh the catalog when the cache is older than a day, so a model that
   * appears tomorrow shows up without a restart. Never throws: on failure
   * the current (cached or default) list is kept.
   */
  async refreshIfStale(): Promise<MuseModel[]> {
    if (!this.stale) return this.#models;
    try {
      return await this.refresh();
    } catch (error) {
      this.#log.debug("model refresh skipped:", error instanceof Error ? error.message : error);
      return this.#models;
    }
  }

  #readCache(): MuseModel[] | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      this.#cachedAt = fs.statSync(this.#file).mtimeMs;
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MuseModel[]) : undefined;
    } catch {
      return undefined;
    }
  }

  #writeCache(models: MuseModel[]): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(this.#file, JSON.stringify(models, null, 2));
      this.#cachedAt = Date.now();
    } catch (error) {
      this.#log.debug("could not cache model list", error);
    }
  }
}

/**
 * Friendly name for a `muse-*` id the server labels with the bare id:
 * `muse-spark-1.3-contributor` becomes "Muse Spark 1.3 Contributor" and
 * `muse-wonder-1.0` becomes "Muse Wonder" (a trailing 1.0 is dropped).
 * Anything else is returned unchanged.
 */
export function prettyModelName(id: string): string {
  const contributor = id.endsWith("-contributor");
  const base = contributor ? id.slice(0, -"-contributor".length) : id;
  const parts = base.split("-");
  if (parts.length < 2 || parts[0] !== "muse") return id;
  if (parts[parts.length - 1] === "1.0") parts.pop();
  const words = parts.map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)));
  return `${words.join(" ")}${contributor ? " Contributor" : ""}`;
}

/** Display name that keeps the model id visible, so `muse-spark-1.3` and its contributor variant can't be confused. */
export function displayName(m: MuseModel): string {
  if (m.name && m.name !== m.id) return `${m.name} (${m.id})`;
  return prettyModelName(m.id);
}

/** The `models` block of an OpenCode provider entry. */
export function toOpencodeModels(models: MuseModel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of models) {
    const variants: Record<string, unknown> = {};
    for (const effort of m.efforts) variants[effort] = { reasoningEffort: effort };
    out[m.id] = {
      name: displayName(m),
      reasoning: true,
      tool_call: false,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: m.context, output: m.output },
      cost: { input: 0, output: 0 },
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
    };
  }
  return out;
}

/** OpenCode 2 `Model.Info` entries for `ctx.provider.transform` → `editor.add`. */
export function toOpencode2Models(models: MuseModel[], providerID: string): Record<string, unknown>[] {
  return models.map((m) => ({
    id: m.id,
    modelID: m.id,
    providerID,
    name: displayName(m),
    // Muse runs its own tools; OpenCode's are never offered to it.
    capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
    compatibility: { reasoningField: "reasoning_content" },
    // `body` lands in the chat request as-is, which is where the proxy reads it.
    variants: m.efforts.map((effort) => ({ id: effort, body: { reasoning_effort: effort } })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: m.context, output: m.output },
  }));
}
