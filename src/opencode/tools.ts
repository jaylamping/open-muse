import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../config.js";

/**
 * Read-only tools open-muse exposes to Muse for the current OpenCode
 * conversation. v1 executes locally in the proxy process:
 *
 * - strictly scoped to the conversation's project directory (no traversal),
 * - sensitive files refused (the `*.env` class OpenCode itself denies),
 * - every call logged with its conversation key.
 *
 * OpenCode-owned execution (permissions, sandbox, audit) needs a host API
 * for running tools that plugins don't get today; this module keeps the
 * `ToolExecutor` seam so a host-backed executor can replace it later.
 */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Project directory of the OpenCode conversation that owns the Muse session. */
  directory: string;
}

export type ToolExecutor = (call: ToolCall, log: Logger) => Promise<string>;

const MAX_TEXT = 20_000;
const MAX_MATCHES = 50;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_BYTES = 1_000_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Minimal `*` / `**` / `?` matcher, so glob needs no dependency. Skips node_modules, .git, and symlink loops. */
function segmentRe(seg: string): RegExp {
  const esc = seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${esc}$`);
}

async function* matchParts(dirAbs: string, relParts: string[], patParts: string[]): AsyncGenerator<string> {
  const [head, ...tail] = patParts;
  if (head === undefined) {
    yield relParts.join("/");
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(relParts.length > 0 ? path.join(dirAbs, ...relParts) : dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  if (head === "**") {
    yield* matchParts(dirAbs, relParts, tail);
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
      yield* matchParts(dirAbs, [...relParts, e.name], patParts);
    }
    return;
  }
  const re = segmentRe(head);
  const last = tail.length === 0;
  for (const e of entries) {
    if (!re.test(e.name)) continue;
    if (last) {
      if (e.name !== "node_modules" && e.name !== ".git") yield [...relParts, e.name].join("/");
    } else if (e.isDirectory()) {
      yield* matchParts(dirAbs, [...relParts, e.name], tail);
    }
  }
}

/** Basenames never served, mirroring the sensitive-file class OpenCode denies. */
const DENIED = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /credentials/i, /secret/i, /^id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/];

function inside(directory: string, target: string): string {
  const resolved = path.resolve(directory, target);
  const root = path.resolve(directory) + path.sep;
  if (resolved !== path.resolve(directory) && !resolved.startsWith(root)) {
    throw new Error(`path escapes the project directory: ${target}`);
  }
  const base = path.basename(resolved);
  if (DENIED.some((re) => re.test(base))) throw new Error(`refusing to serve sensitive file: ${base}`);
  if (resolved.split(path.sep).includes(".git")) throw new Error("refusing to serve .git internals");
  return resolved;
}

async function readText(directory: string, rel: string): Promise<string> {
  const full = inside(directory, rel);
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) throw new Error(`not a file: ${rel}`);
  if (stat.size > MAX_SCAN_BYTES) throw new Error(`file too large: ${rel}`);
  const content = await fs.readFile(full, "utf8").catch(() => null);
  if (content === null || content.includes("\0")) throw new Error(`not a text file: ${rel}`);
  return content.length > MAX_TEXT ? `${content.slice(0, MAX_TEXT)}\n…(truncated)` : content;
}

/** The read-only toolset, shared by the MCP server and its tests. */
export const READONLY_TOOLS = ["read", "grep", "glob"] as const;

async function grepFiles(args: Record<string, unknown>, directory: string): Promise<string> {
  const pattern = str(args.pattern);
  if (!pattern) throw new Error("open-muse grep needs a {pattern} argument");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    throw new Error(`invalid regex: ${pattern}`);
  }
  const out: string[] = [];
  let scanned = 0;
  for await (const rel of matchParts(path.resolve(directory), [], ["**", "*"])) {
    if (out.length >= MAX_MATCHES || scanned >= MAX_SCAN_FILES) break;
    scanned++;
    let content: string;
    try {
      content = await readText(directory, rel);
    } catch {
      continue;
    }
    for (const [i, line] of content.split("\n").entries()) {
      if (re.test(line)) {
        out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (out.length >= MAX_MATCHES) break;
      }
    }
  }
  if (out.length >= MAX_MATCHES) out.push("…(more matches)");
  return out.join("\n") || "(no matches)";
}

async function globFiles(args: Record<string, unknown>, directory: string): Promise<string> {
  const query = str(args.query);
  if (!query) throw new Error("open-muse glob needs a {query} argument");
  const names: string[] = [];
  for await (const rel of matchParts(path.resolve(directory), [], query.split("/"))) {
    names.push(rel);
    if (names.length >= MAX_MATCHES) {
      names.push("…(more files)");
      break;
    }
  }
  return names.join("\n") || "(no files)";
}

/** Execute one bridged tool call. Unknown tools fail closed: never passthrough. */
export function createToolExecutor(): ToolExecutor {
  return async ({ tool, args, directory }, log) => {
    log.debug("bridged tool call", tool, directory);
    switch (tool) {
      case "read": {
        const rel = str(args.path);
        if (!rel) throw new Error("open-muse read needs a {path} argument");
        return readText(directory, rel);
      }
      case "grep":
        return grepFiles(args, directory);
      case "glob":
        return globFiles(args, directory);
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  };
}
