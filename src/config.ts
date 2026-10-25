import os from "node:os";
import path from "node:path";

/** How open-muse answers Muse Code's tool-approval requests. */
export type ApprovalPolicy = "allow" | "deny" | "host";

/** Where Muse's own tool activity (bash, edits, searches) is shown in OpenCode. */
export type ToolDisplay = "reasoning" | "content" | "hidden";

export interface OpenMuseConfig {
  /** OpenCode provider id the plugin registers. Models show up as `<providerId>/<model>`. */
  providerId: string;
  /** The Muse Code CLI binary. */
  museBin: string;
  /** Extra args placed before `serve` (used by tests to run a fake host through node). */
  museArgsPrefix: string[];
  /** Extra environment variables for `muse serve`. */
  museEnv: Record<string, string>;
  /** Proxy port; 0 picks a free port. */
  port: number;
  host: string;
  approvals: ApprovalPolicy;
  toolDisplay: ToolDisplay;
  /** Forward OpenCode's system prompt to Muse. Off by default: it describes OpenCode's tools, which Muse doesn't have. */
  forwardSystemPrompt: boolean;
  /** Answer OpenCode's session-title requests locally instead of spending a Muse prompt on them. */
  localTitles: boolean;
  /**
   * Picking a `-contributor` model runs it on a host spawned with
   * `muse serve --contributor-mode on`; standard models run with `off`
   * (Muse Code's own default is on, hence the default here). Every listed
   * model gains a derived `-contributor` twin unless the server lists one.
   * Set to `false` for the legacy single host (no flag) and the server
   * catalog as-is.
   */
  contributor: boolean;
  /**
   * Expose OpenCode's read-only tools (read, grep, glob) to Muse as a
   * per-session MCP server, executed by OpenCode itself. Off by default:
   * enabling it changes what Muse can reach for.
   */
  tools: boolean;
  stateDir: string;
  debug: boolean;
  /** Append every protocol notification from `muse serve` to this file (JSON lines), for troubleshooting. */
  traceFile?: string;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function defaultStateDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "open-muse");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "open-muse");
}

/** Plugin options (from `["open-muse", { ... }]` in opencode.json) win over env vars, which win over defaults. */
export function resolveConfig(options: Record<string, unknown> = {}): OpenMuseConfig {
  const env = process.env;
  const port = Number(options.port ?? env.OPEN_MUSE_PORT ?? 0);
  return {
    providerId: String(options.providerId ?? env.OPEN_MUSE_PROVIDER_ID ?? "muse"),
    museBin: String(options.museBin ?? env.OPEN_MUSE_BIN ?? "muse"),
    museArgsPrefix: Array.isArray(options.museArgsPrefix) ? options.museArgsPrefix.map(String) : [],
    museEnv:
      options.museEnv && typeof options.museEnv === "object"
        ? Object.fromEntries(Object.entries(options.museEnv as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    port: Number.isFinite(port) ? port : 0,
    host: String(options.host ?? env.OPEN_MUSE_HOST ?? "127.0.0.1"),
    approvals: oneOf(options.approvals ?? env.OPEN_MUSE_APPROVALS, ["allow", "deny", "host"] as const, "allow"),
    toolDisplay: oneOf(options.toolDisplay ?? env.OPEN_MUSE_TOOL_DISPLAY, ["reasoning", "content", "hidden"] as const, "reasoning"),
    forwardSystemPrompt:
      typeof options.forwardSystemPrompt === "boolean" ? options.forwardSystemPrompt : envFlag("OPEN_MUSE_FORWARD_SYSTEM", false),
    localTitles: typeof options.localTitles === "boolean" ? options.localTitles : envFlag("OPEN_MUSE_LOCAL_TITLES", true),
    contributor: typeof options.contributor === "boolean" ? options.contributor : envFlag("OPEN_MUSE_CONTRIBUTOR", true),
    tools: typeof options.tools === "boolean" ? options.tools : envFlag("OPEN_MUSE_TOOLS", false),
    stateDir: String(options.stateDir ?? env.OPEN_MUSE_STATE_DIR ?? defaultStateDir()),
    debug: typeof options.debug === "boolean" ? options.debug : envFlag("OPEN_MUSE_DEBUG", false),
    traceFile: typeof options.traceFile === "string" ? options.traceFile : env.OPEN_MUSE_TRACE_FILE || undefined,
  };
}

export function createLogger(config: Pick<OpenMuseConfig, "debug">) {
  return {
    debug: (...args: unknown[]) => {
      if (config.debug) console.error("[open-muse]", ...args);
    },
    warn: (...args: unknown[]) => console.error("[open-muse]", ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
