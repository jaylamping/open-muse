/** @jsxImportSource @opentui/solid */

// open-muse TUI plugin (OpenCode 2.x): subscription quota in the sidebar footer.
//
// Discovered by OpenCode 2.x as the `tui` sibling of the server plugin — NOT
// by the tsc build (loaded as-is; the host provides `solid-js` and
// `@opentui/solid`). No config needed: the server plugin directory is the
// discovery root.
//
// It finds the proxy through `<stateDir>/proxy.json` (written by the proxy on
// start) and reads its `GET /v1/usage` every minute and after each turn:
// no port to configure.

import type { Plugin } from "@opencode/plugin/tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSignal, onCleanup } from "solid-js";

const REFRESH_MS = 60_000;

function defaultStateDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "open-muse");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "open-muse");
}

function proxyOrigin(stateDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(stateDir, "proxy.json"), "utf8");
    const parsed = JSON.parse(raw) as { origin?: unknown };
    return typeof parsed.origin === "string" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function resetLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${time}`;
}

interface Quota {
  windowPercent: number;
  weeklyPercent: number;
  windowReset: string;
  weeklyReset: string;
}

function parseQuota(data: any): Quota | undefined {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windowPercent = num(data?.window?.usedPercent);
  const weeklyPercent = num(data?.weekly?.usedPercent);
  const windowReset = num(data?.window?.resetsAtMs);
  const weeklyReset = num(data?.weekly?.resetsAtMs);
  if (
    windowPercent === undefined ||
    weeklyPercent === undefined ||
    windowReset === undefined ||
    weeklyReset === undefined
  ) {
    return undefined;
  }
  return { windowPercent, weeklyPercent, windowReset: resetLabel(windowReset), weeklyReset: resetLabel(weeklyReset) };
}

export default {
  id: "open-muse-quota",
  setup(ctx: Plugin.Context) {
    const stateDir = String(ctx.options.stateDir ?? process.env.OPEN_MUSE_STATE_DIR ?? defaultStateDir());
    const providerId = String(ctx.options.providerId ?? "muse");

    const [quota, setQuota] = createSignal<Quota | null>(null);
    const [pending, setPending] = createSignal(true);
    const [collapsed, setCollapsed] = createSignal(false);
    const refresh = async () => {
      try {
        const origin = proxyOrigin(stateDir);
        if (!origin) {
          setQuota(null);
          return;
        }
        const res = await fetch(`${origin}/v1/usage`);
        if (!res.ok) {
          setQuota(null);
          return;
        }
        const body = (await res.json()) as { data?: unknown };
        setQuota(parseQuota(body.data) ?? null);
      } catch {
        setQuota(null);
      } finally {
        setPending(false);
      }
    };

    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    onCleanup(() => clearInterval(timer));

    // Refresh right after a turn lands too, so the panel picks up fresh
    // quota without waiting for the next tick. Event names are best-effort:
    // a rename must never break the slot.
    const unsubscribers: Array<() => void> = [];
    for (const type of ["message.updated", "session.updated"] as const) {
      try {
        unsubscribers.push(ctx.data.on(type, () => void refresh()));
      } catch {
        // ignore unknown event names
      }
    }

    const green = () => ctx.theme.text.feedback.success.base;
    const fg = () => ctx.theme.text.base;

    const release = ctx.ui.slot({
      append: "sidebar.content",
      render: () => {
        // Only for Muse Code models: the quota is meaningless elsewhere.
        const current = ctx.ui.model.current();
        if (current?.providerID !== providerId) return null;
        const q = quota();
        const head = (
          <box flexDirection="row" onMouseDown={() => setCollapsed(!collapsed())}>
            <text>{collapsed() ? "▶ Muse Code quota" : "▼ Muse Code quota"}</text>
          </box>
        );
        if (collapsed() || !q) {
          return (
            <box flexDirection="column">
              {head}
              {!q && (
                <box flexDirection="row" columnGap={1}>
                  <text style={{ fg: green() }}>•</text>
                  <text style={{ fg: fg() }}>{pending() ? "…" : "—"}</text>
                </box>
              )}
            </box>
          );
        }
        const pct = (n: number): string => `${String(n).padStart(3, " ")}%`;
        return (
          <box flexDirection="column">
            {head}
            <box flexDirection="row" columnGap={1}>
              <text style={{ fg: green() }}>•</text>
              <text style={{ fg: fg() }}>{"5h  "}</text>
              <text style={{ fg: fg() }}>
                {pct(q.windowPercent)} (reset at {q.windowReset})
              </text>
            </box>
            <box flexDirection="row" columnGap={1}>
              <text style={{ fg: green() }}>•</text>
              <text style={{ fg: fg() }}>week</text>
              <text style={{ fg: fg() }}>
                {pct(q.weeklyPercent)} (reset at {q.weeklyReset})
              </text>
            </box>
          </box>
        );
      },
    });

    return () => {
      clearInterval(timer);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      release();
    };
  },
};
