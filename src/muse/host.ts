import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnMspConnection } from "@muse-code/sdk";
import type { Connection, SpawnedMspConnection } from "@muse-code/sdk";
import type { OpenMuseConfig, Logger } from "../config.js";

export interface MspNotification {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type Listener = (notification: MspNotification) => void;

const VERSION = "0.1.0";

/**
 * One long-lived `muse serve` child, shared by every OpenCode session.
 *
 * Spawned lazily on first use and respawned after it exits. Sessions are loaded
 * per host process, so after a respawn callers must `session/resume` before
 * starting a turn — `isLoaded`/`markLoaded` track that per generation.
 */
export class MuseHost {
  #config: OpenMuseConfig;
  #log: Logger;
  /** Explicit `--contributor-mode` for this host. Undefined keeps the legacy
   * behavior: the flag is passed only when the `contributor` option is on. */
  #contributorMode: "on" | "off" | undefined;
  #spawned: Promise<SpawnedMspConnection> | undefined;
  #listeners = new Set<Listener>();
  #loaded = new Set<string>();
  #stderrTail: string[] = [];
  #closing = false;

  constructor(config: OpenMuseConfig, log: Logger, contributorMode?: "on" | "off") {
    this.#config = config;
    this.#log = log;
    this.#contributorMode = contributorMode;
  }

  /** Subscribe to every notification the host pushes. Returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connection(): Promise<Connection> {
    return (await this.#ensure()).connection;
  }

  async initializeResult() {
    return (await this.#ensure()).initializeResult;
  }

  isLoaded(museSessionId: string): boolean {
    return this.#loaded.has(museSessionId);
  }

  markLoaded(museSessionId: string): void {
    this.#loaded.add(museSessionId);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (await this.connection()).request(method, params);
  }

  async command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.connection()).command(method, params);
  }

  #ensure(): Promise<SpawnedMspConnection> {
    if (this.#closing) return Promise.reject(new Error("open-muse host is shutting down"));
    this.#spawned ??= this.#spawn().catch((error: unknown) => {
      this.#spawned = undefined;
      throw error;
    });
    return this.#spawned;
  }

  async #spawn(): Promise<SpawnedMspConnection> {
    const { museBin } = this.#config;
    const resolved = resolveBinary(museBin);
    if (!resolved) throw new MuseHostError(notInstalledMessage(museBin));
    // Node can't spawn .cmd/.bat shims directly on Windows; route them through cmd.exe.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
    const command = viaCmd ? process.env.ComSpec ?? "cmd.exe" : resolved;
    const mode = this.#contributorMode ?? (this.#config.contributor ? "on" : undefined);
    const args = [
      ...(viaCmd ? ["/d", "/s", "/c", resolved] : []),
      ...this.#config.museArgsPrefix,
      "serve",
      ...(mode === undefined ? [] : ["--contributor-mode", mode]),
    ];
    this.#log.debug("spawning", command, args.join(" "));
    this.#stderrTail = [];
    const handshake = spawnMspConnection({
      command,
      args,
      env: { ...process.env, ...this.#config.museEnv },
      onStderr: (chunk) => {
        this.#stderrTail.push(chunk);
        if (this.#stderrTail.length > 40) this.#stderrTail.shift();
        this.#log.debug("muse stderr:", chunk.trimEnd());
      },
    });
    // Subscribe before the handshake: anything pushed before a handler exists is dropped.
    handshake.onNotification((n) => this.#dispatch(n));
    // We never render dialogs; decline any server-initiated request so a turn can't wedge on it.
    handshake.onServerRequest(async (request) => {
      this.#log.debug("declining server request", request.method);
      throw new Error(`open-muse does not handle ${request.method}`);
    });

    let spawned: SpawnedMspConnection;
    try {
      spawned = await handshake.initialize({
        clientInfo: { name: "open_muse", title: "open-muse (OpenCode bridge)", version: VERSION },
        capabilities: { userInputDialogs: false },
      });
    } catch (error) {
      throw new MuseHostError(describeSpawnFailure(museBin, error, this.#stderrTail), { cause: error });
    }
    if (spawned.fingerprintWarning) this.#log.debug("protocol fingerprint differs from SDK pin (usually harmless)");

    void spawned.exited.then((exit) => {
      this.#log.debug("muse serve exited", exit);
      this.#loaded.clear();
      this.#spawned = undefined;
      this.#dispatch({ method: "open-muse/hostExited", params: { code: exit.code, signal: exit.signal } });
    });
    return spawned;
  }

  #dispatch(notification: MspNotification): void {
    if (this.#config.traceFile) {
      try {
        fs.appendFileSync(this.#config.traceFile, `${JSON.stringify({ at: Date.now(), ...notification })}\n`);
      } catch {
        // tracing is best-effort
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(notification);
      } catch (error) {
        this.#log.warn("listener failed", error);
      }
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const spawned = await this.#spawned?.catch(() => undefined);
    await spawned?.close().catch(() => undefined);
  }
}

export class MuseHostError extends Error {}

function notInstalledMessage(museBin: string): string {
  return (
    `Could not find the Muse Code CLI ("${museBin}"). Install it from https://dev.meta.ai/docs/muse-code ` +
    `(macOS/Linux: curl -fsSL https://dev.meta.ai/install.sh | sh, Windows: irm https://dev.meta.ai/install.ps1 | iex), ` +
    `run \`muse\` once to sign in, or set OPEN_MUSE_BIN to the full path of the muse binary.`
  );
}

function describeSpawnFailure(museBin: string, error: unknown, stderr: string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  const tail = stderr.join("").trim().split(/\r?\n/).slice(-5).join("\n");
  if (/ENOENT/i.test(message)) return notInstalledMessage(museBin);
  return `muse serve failed to start: ${message}${tail ? `\n${tail}` : ""}`;
}

/**
 * Find `bin` the way a shell would, then skip Muse's launcher.
 *
 * Meta's installers put a launcher on PATH (`muse.cmd` + PowerShell on Windows,
 * a bash script in `~/.local/bin` on macOS/Linux) that runs `muse-bin-<version>`
 * from the same folder, with the version in `.muse-version`. We spawn that binary
 * directly: piping the stdio protocol through PowerShell is fragile, and the
 * launcher's update check would delay every start. It's the same file the
 * launcher picks, so updates installed by running `muse` still apply.
 */
export function resolveBinary(bin: string): string | undefined {
  const found = findOnPath(bin);
  if (!found) return found;
  try {
    const dir = path.dirname(found);
    const version = fs.readFileSync(path.join(dir, ".muse-version"), "utf8").trim();
    if (!/^[\w.+-]+$/.test(version)) return found;
    const active = path.join(dir, `muse-bin-${version}${process.platform === "win32" ? ".exe" : ""}`);
    if (fs.statSync(active).isFile()) return active;
  } catch {
    // Not the Muse launcher layout; use what we found as-is.
  }
  return found;
}

function findOnPath(bin: string): string | undefined {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  const candidates = (base: string) => exts.map((e) => base + e.toLowerCase()).concat(exts.map((e) => base + e));
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return candidates(path.resolve(bin)).find(isFile);
  }
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  // The Muse installer's usual locations, in case they aren't on OpenCode's PATH yet
  // (the installer only updates PATH for terminals opened afterwards).
  if (process.platform === "win32") {
    dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "muse"));
  }
  // macOS apps started from the Dock/Finder get a minimal PATH without these.
  dirs.push(
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".muse", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  );
  for (const dir of dirs) {
    const hit = candidates(path.join(dir, bin)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}
