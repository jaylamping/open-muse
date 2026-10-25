#!/usr/bin/env node
import { createLogger, resolveConfig } from "./config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseHost, resolveBinary } from "./muse/host.js";
import { ModelCatalog } from "./muse/models.js";
import { readUsage } from "./muse/usage.js";
import { runTurn } from "./muse/turn.js";
import { startProxy } from "./proxy/server.js";

const USAGE = `open-muse — use your Muse Code subscription from OpenCode

Usage:
  open-muse doctor [--no-turn]
                            Check that the muse CLI starts, is signed in, and list your models.
                            The sign-in check runs one tiny turn; --no-turn skips it.
  open-muse serve [--port N] Run the OpenAI-compatible proxy standalone (default port 4517)

Setup: add "open-muse" to "plugin" (OpenCode 1.x) or "plugins" (OpenCode 2.x) in
~/.config/opencode/opencode.json.`;

async function doctor(args: string[]): Promise<number> {
  const config = resolveConfig();
  const log = createLogger(config);
  const bin = resolveBinary(config.museBin);
  if (!bin) {
    console.error(`✗ Could not find the Muse Code CLI ("${config.museBin}"). Install it, or set OPEN_MUSE_BIN.`);
    return 1;
  }
  // Printed so a different `muse` earlier on PATH (or a shell alias) is easy to spot.
  const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim();
  console.log(`✓ muse binary: ${bin}${version ? ` (${version})` : ""}`);

  const host = new MuseHost(config, log);
  let ok = true;
  try {
    const init = await host.initializeResult();
    console.log(`✓ muse serve started (${init.serverInfo?.name ?? "muse"} ${init.serverInfo?.version ?? ""})`.trimEnd());
    console.log(`  muse home: ${init.museHome}`);

    const models = await new ModelCatalog(host, config, log).refresh();
    console.log(`✓ ${models.length} model(s) available:`);
    for (const m of models) console.log(`  - ${config.providerId}/${m.id}${m.isDefault ? " (default)" : ""}`);

    await showModeDefaults(config, log);

    if (args.includes("--no-turn")) console.log("· sign-in not checked (--no-turn)");
    else ok = (await checkSignIn(host, config, log)) && ok;

    // After the test turn so the host observed usage when signed in.
    await showSubscriptionUsage(host, log);

    if (process.platform === "win32") ok = checkWindowsSandbox(config.museBin) && ok;
  } catch (error) {
    ok = false;
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await host.close();
  }
  if (ok) console.log('\nReady. In OpenCode, pick a "muse/..." model (e.g. /models).');
  return ok ? 0 : 1;
}

/**
 * Show each model's default effort with contributor mode off vs on. A difference
 * proves the mode is meaningful for that model; identical values prove nothing
 * either way. Informational only: never fails the doctor run.
 */
async function showModeDefaults(config: ReturnType<typeof resolveConfig>, log: ReturnType<typeof createLogger>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-doctor-modes-"));
  const hosts: MuseHost[] = [];
  try {
    const list = async (mode: "on" | "off"): Promise<Map<string, string>> => {
      const host = new MuseHost({ ...config, contributor: false }, log, mode);
      hosts.push(host);
      // Raw server list (no twins): compare what each mode really reports.
      const catalog = new ModelCatalog(host, { ...config, stateDir: dir, contributor: false }, log);
      const models = await catalog.refresh();
      return new Map(models.map((m) => [m.id, m.defaultEffort ?? "?"]));
    };
    const [off, on] = await Promise.all([list("off"), list("on")]);
    const ids = [...new Set([...off.keys(), ...on.keys()])].sort();
    if (ids.length === 0) return;
    console.log("  default effort per mode (standard | contributor):");
    for (const id of ids) {
      const a = off.get(id) ?? "?";
      const b = on.get(id) ?? "?";
      console.log(`    - ${id}: ${a} | ${b}${a !== b ? "  * differs" : ""}`);
    }
  } catch (error) {
    log.debug("mode comparison skipped:", error instanceof Error ? error.message : error);
  } finally {
    await Promise.all(hosts.map((h) => h.close().catch(() => undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Show the subscription quota (5h window, weekly) when the host observed it. */
async function showSubscriptionUsage(host: MuseHost, log: ReturnType<typeof createLogger>): Promise<void> {
  const data = await readUsage(host, log);
  if (!data) {
    console.log("  subscription usage: not observed yet (run a turn first)");
    return;
  }
  /** Local `YYYY-MM-DD HH:MM`: doctor output faces the user, and bare UTC misleads. */
  const at = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} local`;
  };
  console.log(
    `  subscription usage: window ${data.window.usedPercent}% (resets ${at(data.window.resetsAtMs)}), ` +
      `weekly ${data.weekly.usedPercent}% (resets ${at(data.weekly.resetsAtMs)})`,
  );
}

/**
 * Listing models works signed out, and muse serve has no account call, so the only
 * reliable sign-in check is a turn. It runs in an empty temp folder with the lowest
 * effort and no tool approvals, so it costs a few tokens.
 */
async function checkSignIn(host: MuseHost, config: ReturnType<typeof resolveConfig>, log: ReturnType<typeof createLogger>): Promise<boolean> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-doctor-"));
  try {
    const started = await host.command("session/start", { workspaceRoot: workspace });
    const sessionId = (started.session as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error("muse serve did not return a session id");
    host.markLoaded(sessionId);
    const turn = runTurn(host, {
      sessionId,
      input: [{ type: "text", text: "Reply with just: OK" }],
      reasoningEffort: "minimal",
      approvals: "deny",
      log,
      signal: AbortSignal.timeout(120_000),
    });
    for await (const event of turn) {
      if (event.type !== "done") continue;
      if (!event.error) {
        console.log("✓ signed in (test turn completed)");
        return true;
      }
      if (event.error.kind === "authRequired") {
        console.log("✗ Muse Code is not signed in. Run `muse login`, then run doctor again.");
      } else if (event.error.quota !== undefined) {
        console.log(`✗ signed in, but your plan's usage limit is reached: ${event.error.message}`);
      } else {
        console.log(`✗ test turn failed (${event.error.kind}): ${event.error.message}`);
      }
      return false;
    }
    console.log("✗ test turn ended without a result");
    return false;
  } catch (error) {
    console.log(`✗ test turn failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** Muse's tools run in an OS sandbox; on Windows it needs a one-time elevated setup or every command fails. */
function checkWindowsSandbox(museBin: string): boolean {
  const bin = resolveBinary(museBin);
  if (!bin) return false;
  const result = spawnSync(bin, ["sandbox", "windows", "check"], { encoding: "utf8", timeout: 30_000 });
  const status = /^status=(.*)$/m.exec(result.stdout ?? "")?.[1]?.trim();
  if (result.status === 0) {
    console.log(`✓ Windows sandbox ready${status ? ` (${status})` : ""}`);
    return true;
  }
  const reason = /^reason=(.*)$/m.exec(result.stdout ?? "")?.[1]?.trim();
  console.log(`✗ Windows sandbox not ready${reason ? `: ${reason}` : ""}`);
  console.log("  Muse can't run shell commands until it's set up. In a terminal, run once (asks for admin):");
  console.log("    muse sandbox windows setup");
  return false;
}

async function serve(args: string[]): Promise<number> {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.OPEN_MUSE_PORT ?? 4517);
  const proxy = await startProxy(resolveConfig({ port }));
  console.log(`open-muse proxy listening on ${proxy.url}`);
  const stop = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<number>(() => {});
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "doctor" ? doctor(rest) : command === "serve" ? serve(rest) : Promise.resolve((console.log(USAGE), command ? 1 : 0));
run.then((code) => process.exit(code));
