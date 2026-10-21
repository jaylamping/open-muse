import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../dist/proxy/server.js";
import { resolveConfig } from "../dist/config.js";
import { resolveBinary } from "../dist/muse/host.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-test-"));
const logFile = path.join(tmp, "requests.jsonl");
process.env.FAKE_MUSE_LOG = logFile;
const usageFile = path.join(tmp, "state", "usage.json");
process.env.OPEN_MUSE_USAGE_FILE = usageFile;

const config = (extra = {}) =>
  resolveConfig({ museBin: process.execPath, museArgsPrefix: [path.join(here, "fake-muse.mjs")], port: 0, stateDir: tmp, ...extra });

let proxy;
before(async () => {
  proxy = await startProxy(config());
});
after(async () => {
  await proxy?.close();
});

const requests = () =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const count = (method) => requests().filter((r) => r.method === method).length;

async function chat(body, headers = {}, base = proxy.url) {
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "muse-spark-1.3", stream: true, ...body }),
  });
}

/** Read an SSE response into { content, reasoning, finish, usage, error }. */
async function collect(res) {
  const out = { content: "", reasoning: "", finish: undefined, usage: undefined, error: undefined, done: false };
  const text = await res.text();
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") {
      out.done = true;
      continue;
    }
    const chunk = JSON.parse(data);
    if (chunk.error) out.error = chunk.error;
    if (chunk.usage) out.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      out.content += choice.delta?.content ?? "";
      out.reasoning += choice.delta?.reasoning_content ?? "";
      if (choice.finish_reason) out.finish = choice.finish_reason;
    }
  }
  return out;
}

const session = (id, agent = "build") => ({
  "x-open-muse-session": id,
  "x-open-muse-agent": agent,
  "x-open-muse-directory": tmp,
});

test("lists models", async () => {
  const res = await fetch(`${proxy.url}/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((m) => m.id === "muse-spark-1.3"));
});

test("streams a turn: text, reasoning, usage", async () => {
  const res = await chat({ messages: [{ role: "system", content: "OpenCode tools..." }, { role: "user", content: "hello" }] }, session("s-basic"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const out = await collect(res);
  assert.equal(out.content, "Muse heard: hello [images=0] [model=muse-spark-1.3] [effort=default]");
  assert.equal(out.reasoning, "Thinking about the request.");
  assert.equal(out.finish, "stop");
  assert.equal(out.usage.prompt_tokens, 120);
  assert.equal(out.usage.completion_tokens, 30);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 20);
  assert.ok(!out.reasoning.includes("Reminder"), "background reviewer items are not traced");
  assert.ok(out.done);
  assert.ok(!out.content.includes("OpenCode tools"), "system prompt is not forwarded by default");
});

test("writes plan usage to the usage file", async () => {
  await collect(await chat({ messages: [{ role: "user", content: "usage please" }] }, session("s-usage")));
  for (let i = 0; i < 50 && count("usage/read") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(count("usage/read"), 1, "asks once after the first finished turn");
  const written = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  assert.ok(written.writtenAtMs > 0);
  delete written.writtenAtMs;
  assert.deepEqual(written, {
    tier: "fake-plan",
    window: { usedPercent: 12, windowDurationMins: 300, resetsAtMs: 1_900_000_000_000 },
    weekly: { usedPercent: 3, resetsAtMs: 1_900_500_000_000 },
    observedAtMs: 1_800_000_000_000,
  });
  if (process.platform !== "win32") assert.equal(fs.statSync(usageFile).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(path.dirname(usageFile)), ["usage.json"], "no temp files left behind");
  await collect(await chat({ messages: [{ role: "user", content: "again" }] }, session("s-usage-2")));
  assert.equal(count("usage/read"), 1, "does not ask again on later turns");
});

test("usage file: missing fields are left out, and it can be turned off", async () => {
  const { planUsage } = await import("../dist/muse/usage.js");
  assert.deepEqual(planUsage({ tier: "t", window: { usedPercent: 5, extra: "x" }, secret: "no" }), { tier: "t", window: { usedPercent: 5 } });
  assert.equal(planUsage({ tier: "t" }), undefined);
  assert.equal(config({ usageFile: false }).usageFile, undefined);
  process.env.OPEN_MUSE_USAGE_FILE = "off";
  try {
    assert.equal(resolveConfig({}).usageFile, undefined);
  } finally {
    process.env.OPEN_MUSE_USAGE_FILE = usageFile;
  }
});

test("continues the same Muse session, sending only the new message", async () => {
  const starts = count("session/start");
  const history = [{ role: "user", content: "first" }];
  let out = await collect(await chat({ messages: history }, session("s-cont")));
  history.push({ role: "assistant", content: out.content }, { role: "user", content: "second" });
  out = await collect(await chat({ messages: history }, session("s-cont")));
  assert.equal(out.content, "Muse heard: second [images=0] [model=muse-spark-1.3] [effort=default]");
  assert.equal(count("session/start") - starts, 1, "one Muse session for the whole conversation");
});

test("edited history starts a fresh session seeded with the transcript", async () => {
  await collect(await chat({ messages: [{ role: "user", content: "alpha" }] }, session("s-div")));
  const starts = count("session/start");
  const out = await collect(
    await chat(
      {
        messages: [
          { role: "user", content: "alpha EDITED" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "beta" },
        ],
      },
      session("s-div"),
    ),
  );
  assert.equal(count("session/start") - starts, 1);
  assert.match(out.content, /<conversation_history>/);
  assert.match(out.content, /alpha EDITED/);
  assert.match(out.content, /beta/);
});

test("auto-approves tool use and shows tool activity as reasoning", async () => {
  const out = await collect(await chat({ messages: [{ role: "user", content: "USE_TOOL please" }] }, session("s-tool")));
  assert.match(out.reasoning, /▸ bash: npm test/);
  assert.match(out.reasoning, /auto-approved: bash/);
  assert.match(out.reasoning, /bash done/);
  const decide = requests().filter((r) => r.method === "approval/decide").at(-1);
  assert.equal(decide.params.choiceId, "allow_once");
});

test("plan agent denies tool approvals", async () => {
  const out = await collect(await chat({ messages: [{ role: "user", content: "USE_TOOL in plan" }] }, session("s-plan", "plan")));
  assert.match(out.reasoning, /denied: bash/);
  assert.match(out.reasoning, /bash rejected: denied by user/);
  const decide = requests().filter((r) => r.method === "approval/decide").at(-1);
  assert.equal(decide.params.choiceId, "deny");
  assert.ok(decide.params.feedback);
});

test("title requests are answered locally without a Muse turn", async () => {
  const turns = count("turn/start");
  const out = await collect(
    await chat(
      { messages: [{ role: "user", content: "Generate a title for this conversation:\nFix the flaky login test in CI" }] },
      session("s-title", "title"),
    ),
  );
  assert.equal(out.content, "Fix the flaky login test in CI");
  assert.equal(count("turn/start"), turns);
});

test("auth failure before output is a 401", async () => {
  const res = await chat({ messages: [{ role: "user", content: "FAIL_AUTH" }] }, session("s-auth"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error.message, /not signed in/);
});

test("client disconnect cancels the Muse turn", async () => {
  const controller = new AbortController();
  const res = await chat({ messages: [{ role: "user", content: "SLOW job" }] }, session("s-abort"), proxy.url);
  const reader = res.body.getReader();
  await reader.read(); // first chunk arrived: the turn is running
  await reader.cancel();
  controller.abort();
  for (let i = 0; i < 50 && count("turn/cancel") === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(count("turn/cancel") >= 1);
});

test("non-streaming responses, model selection and reasoning effort", async () => {
  const res = await chat(
    { stream: false, model: "muse/muse-spark-1.3-contributor", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
    session("s-nonstream"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Muse heard: hi [images=0] [model=muse-spark-1.3-contributor] [effort=high]");
  assert.equal(body.choices[0].message.reasoning_content, "Thinking about the request.");
});

test("switching models mid-conversation calls session/setModel", async () => {
  const history = [{ role: "user", content: "one" }];
  let out = await collect(await chat({ messages: history }, session("s-model")));
  history.push({ role: "assistant", content: out.content }, { role: "user", content: "two" });
  out = await collect(await chat({ model: "muse/muse-spark-1.3-contributor", messages: history }, session("s-model")));
  assert.match(out.content, /model=muse-spark-1.3-contributor/);
  assert.ok(count("session/setModel") >= 1);
});

test("images are forwarded as Muse image parts", async () => {
  const png = Buffer.from("fake-png").toString("base64");
  const out = await collect(
    await chat(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
            ],
          },
        ],
      },
      session("s-image"),
    ),
  );
  assert.match(out.content, /\[images=1\]/);
  const turn = requests().filter((r) => r.method === "turn/start").at(-1);
  assert.equal(turn.params.input[1].mediaType, "image/png");
});

test("after a restart, a lost Muse session falls back to a seeded fresh one", async () => {
  const second = await startProxy(config());
  try {
    const history = [{ role: "user", content: "first" }];
    const out1 = await collect(await chat({ messages: history }, session("s-cont"), second.url));
    // s-cont was already two messages deep on the first proxy, so this diverges and is re-seeded.
    assert.match(out1.content, /Muse heard: first/);
    history.push({ role: "assistant", content: out1.content }, { role: "user", content: "next" });
    const out2 = await collect(await chat({ messages: history }, session("s-cont"), second.url));
    assert.equal(out2.content, "Muse heard: next [images=0] [model=muse-spark-1.3] [effort=default]");
  } finally {
    await second.close();
  }
});

test("muse binary missing gives an actionable 503", async () => {
  const broken = await startProxy(resolveConfig({ museBin: path.join(tmp, "no-such-muse"), port: 0, stateDir: tmp }));
  try {
    const res = await chat({ messages: [{ role: "user", content: "hi" }] }, session("s-missing"), broken.url);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error.message, /Install it from https:\/\/dev\.meta\.ai/);
  } finally {
    await broken.close();
  }
});

test("resolveBinary skips the installer's launcher for the active muse-bin", () => {
  // Same layout on every platform: launcher on PATH, `.muse-version`, `muse-bin-<version>` beside it.
  const dir = fs.mkdtempSync(path.join(tmp, "install-"));
  const win = process.platform === "win32";
  const launcher = path.join(dir, win ? "muse.cmd" : "muse");
  const active = path.join(dir, `muse-bin-1.4.6-R6000.1${win ? ".exe" : ""}`);
  fs.writeFileSync(launcher, win ? "@echo off\r\n" : "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(active, "", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".muse-version"), "1.4.6-R6000.1\n");
  assert.equal(resolveBinary(path.join(dir, "muse")), active);

  fs.rmSync(path.join(dir, ".muse-version"));
  assert.equal(resolveBinary(path.join(dir, "muse")), launcher);
});

test("OpenCode 2 setup registers the provider in memory and tags model requests", async () => {
  const { default: plugin } = await import("../dist/plugin.js");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(typeof plugin.server, "function");

  let transform, hook, hookOptions;
  const disposed = [];
  const registration = (name) => ({ dispose: async () => void disposed.push(name) });
  const ctx = {
    location: { directory: "/fallback" },
    options: { museBin: process.execPath, museArgsPrefix: [path.join(here, "fake-muse.mjs")], stateDir: tmp },
    provider: {
      transform: async (cb) => ((transform = cb), registration("transform")),
      reload: async () => {},
    },
    session: {
      get: async ({ sessionID }) => ({ location: { directory: `/projects/${sessionID}` } }),
      hook: async (name, cb, options) => (assert.equal(name, "model.request"), (hook = cb), (hookOptions = options), registration("hook")),
    },
  };
  const cleanup = await plugin.setup(ctx);

  const added = [];
  transform({ add: (input) => added.push(input) });
  assert.equal(added.length, 1);
  const { info, models } = added[0];
  assert.equal(info.id, "muse");
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible");
  assert.match(info.settings.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const spark = models.find((m) => m.id === "muse-spark-1.3");
  assert.equal(spark.capabilities.tools, false);
  assert.deepEqual(spark.variants.find((v) => v.id === "high"), { id: "high", body: { reasoning_effort: "high" } });
  assert.deepEqual(hookOptions, { providerID: "muse" });

  const primary = { sessionID: "ses_1", agent: "build", kind: "primary", headers: { keep: "me" } };
  await hook(primary);
  assert.deepEqual(primary.headers, {
    keep: "me",
    "x-open-muse-session": "ses_1",
    "x-open-muse-agent": "build",
    "x-open-muse-directory": "/projects/ses_1",
  });
  const title = { sessionID: "ses_1", agent: "build", kind: "title", headers: {} };
  await hook(title);
  assert.equal(title.headers["x-open-muse-agent"], "title");

  // The registered provider answers through the proxy.
  const out = await collect(await chat({ messages: [{ role: "user", content: "via v2" }] }, primary.headers, info.settings.baseURL));
  assert.match(out.content, /Muse heard: via v2/);

  await cleanup();
  assert.deepEqual(disposed.sort(), ["hook", "transform"]);
});
