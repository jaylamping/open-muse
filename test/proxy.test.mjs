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

test("contributor option keeps server-listed variants without duplicating them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-contrib-"));
  const contributed = await startProxy(config({ contributor: true, stateDir: dir }));
  try {
    // The server lists both entries here, so no twin is derived.
    await contributed.catalog.refresh();
    const ids = contributed.catalog.models.map((m) => m.id);
    assert.deepEqual(ids, ["muse-spark-1.3", "muse-spark-1.3-contributor"]);
    const res = await fetch(`${contributed.url}/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      (await res.json()).data.map((m) => m.id),
      ids,
    );
  } finally {
    await contributed.close();
  }
});

test("contributor refresh derives a -contributor twin for each new base model", async () => {
  const { ModelCatalog, displayName } = await import("../dist/muse/models.js");
  const { createLogger } = await import("../dist/config.js");
  // A future server lists only the base id: the twin is derived, limits and
  // efforts are copied, and the default flag is never inherited.
  const stubHost = {
    request: async () => ({
      models: [
        { modelId: "muse-new-9.0", displayLabel: "Muse New 9.0", contextLimit: 42, outputLimit: 7, variants: ["low", "high"], isDefault: true, defaultReasoningEffort: "max" },
      ],
    }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-twin-"));
  const cfg = config({ contributor: true, stateDir: dir });
  const catalog = new ModelCatalog(stubHost, cfg, createLogger(cfg));
  const models = await catalog.refresh();
  assert.deepEqual(
    models.map((m) => m.id),
    ["muse-new-9.0", "muse-new-9.0-contributor"],
  );
  const twin = models[1];
  assert.equal(twin.context, 42);
  assert.equal(twin.output, 7);
  assert.deepEqual(twin.efforts, ["low", "high"]);
  assert.equal(twin.isDefault, false);
  assert.equal(displayName(twin), "Muse New 9.0 Contributor");
  assert.equal(twin.defaultEffort, "max");
  // Persisted, so the twin survives restarts without another refresh.
  const cached = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  assert.deepEqual(
    cached.map((m) => m.id),
    ["muse-new-9.0", "muse-new-9.0-contributor"],
  );
});

test("model display names are friendly labels, ids stay raw", async () => {
  const { displayName, prettyModelName } = await import("../dist/muse/models.js");
  assert.equal(prettyModelName("muse-wonder-1.0"), "Muse Wonder");
  assert.equal(prettyModelName("muse-wonder-1.0-contributor"), "Muse Wonder Contributor");
  assert.equal(prettyModelName("muse-spark-1.0"), "Muse Spark");
  assert.equal(prettyModelName("muse-spark-1.3"), "Muse Spark 1.3");
  assert.equal(prettyModelName("muse-spark-1.3-contributor"), "Muse Spark 1.3 Contributor");
  assert.equal(prettyModelName("muse-spark-1.2-contributor"), "Muse Spark 1.2 Contributor");
  assert.equal(prettyModelName("something-else"), "something-else");
  // A server-provided label is kept with the id visible, so base and
  // contributor variants can't be confused.
  assert.equal(displayName({ id: "muse-spark-1.3", name: "Muse Spark 1.3" }), "Muse Spark 1.3 (muse-spark-1.3)");
  assert.equal(displayName({ id: "muse-spark-1.3", name: "muse-spark-1.3" }), "Muse Spark 1.3");
});

test("old cached twins are migrated to the friendly label", async () => {
  const { ModelCatalog, displayName } = await import("../dist/muse/models.js");
  const { createLogger } = await import("../dist/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-migrate-"));
  // Cache as written before twins were named by their own id.
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify([
      { id: "muse-spark-1.3", name: "muse-spark-1.3", context: 1, output: 1, efforts: ["low"] },
      { id: "muse-spark-1.3-contributor", name: "muse-spark-1.3", context: 1, output: 1, efforts: ["low"] },
    ]),
  );
  const cfg = config({ contributor: true, stateDir: dir });
  const stubHost = { request: async () => { throw new Error("cache is fresh, must not refresh"); } };
  const catalog = new ModelCatalog(stubHost, cfg, createLogger(cfg));
  assert.deepEqual(
    catalog.models.map((m) => displayName(m)),
    ["Muse Spark 1.3", "Muse Spark 1.3 Contributor"],
  );
});

test("standard and contributor models run on their own host", async () => {
  const { SessionRouter } = await import("../dist/muse/sessions.js");
  const { createLogger } = await import("../dist/config.js");
  const { isContributorModel } = await import("../dist/muse/models.js");
  const calls = [];
  const stubHost = (name) => ({
    command: async (method, params) => {
      calls.push({ host: name, method, model: params.modelId ?? params.model?.modelId });
      if (method === "session/start") return { session: { sessionId: `${name}-sess` } };
      if (method === "session/resume") return { session: { sessionId: params.sessionId } };
      if (method === "session/setModel") return { status: "accepted" };
      throw new Error(`unexpected ${method}`);
    },
    isLoaded: () => true,
    markLoaded: () => {},
  });
  const standard = stubHost("standard");
  const contributor = stubHost("contributor");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-routing-"));
  const cfg = config({ stateDir: dir });
  const router = new SessionRouter(
    (modelId) => (isContributorModel(modelId) ? contributor : standard),
    cfg,
    createLogger(cfg),
  );
  const history = [];
  const chat = async (modelId, text, reply = "ok") => {
    if (history.length > 0) history.push({ role: "assistant", content: reply });
    history.push({ role: "user", content: text });
    const prepared = await router.prepare({ key: "s-route", workspace: tmp, messages: [...history], modelId });
    prepared.commit();
    prepared.release();
    return prepared;
  };

  // Standard model starts on the standard host.
  let p = await chat("muse-spark-1.3", "first");
  assert.equal(p.host, standard);
  assert.equal(p.museSessionId, "standard-sess");

  // Same conversation, contributor twin: history continues but the mode
  // differs, so a fresh session starts on the contributor host.
  p = await chat("muse-spark-1.3-contributor", "second");
  assert.equal(p.host, contributor);
  assert.equal(p.museSessionId, "contributor-sess");
  assert.ok(calls.some((c) => c.host === "contributor" && c.method === "session/start"));

  // Same-mode model change reuses the session via setModel on the same host.
  const starts = calls.filter((c) => c.method === "session/start").length;
  p = await chat("muse-spark-1.2-contributor", "third");
  assert.equal(p.host, contributor);
  assert.equal(p.museSessionId, "contributor-sess");
  assert.equal(calls.filter((c) => c.method === "session/start").length, starts);
  assert.ok(calls.some((c) => c.host === "contributor" && c.method === "session/setModel" && c.model === "muse-spark-1.2-contributor"));
});

test("twin defaults come from the contributor host", async () => {
  const { ModelCatalog, resolveEffort } = await import("../dist/muse/models.js");
  const { createLogger } = await import("../dist/config.js");
  const row = (defaultReasoningEffort) => ({
    models: [
      { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", contextLimit: 1, outputLimit: 1, variants: ["low", "max"], isDefault: true, defaultReasoningEffort },
    ],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-dual-defaults-"));
  const cfg = config({ contributor: true, stateDir: dir });
  const catalog = new ModelCatalog(
    { request: async () => row("high") },
    cfg,
    createLogger(cfg),
    { request: async () => row("max") },
  );
  const models = await catalog.refresh();
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  assert.equal(byId["muse-spark-1.3"].defaultEffort, "high");
  assert.equal(byId["muse-spark-1.3-contributor"].defaultEffort, "max");
  assert.equal(resolveEffort(models, "muse-spark-1.3"), "high");
  assert.equal(resolveEffort(models, "muse-spark-1.3-contributor"), "max");
});

test("resolveEffort returns the real effort a turn will run with", async () => {
  const { resolveEffort } = await import("../dist/muse/models.js");
  const models = [
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", context: 1, output: 1, efforts: ["low", "max"], defaultEffort: "max" },
  ];
  assert.equal(resolveEffort(models, "muse-spark-1.3", "low"), "low");
  assert.equal(resolveEffort(models, "muse-spark-1.3"), "max");
  assert.equal(resolveEffort(models, "muse-unknown-9.9"), "default");
  assert.equal(resolveEffort(models, undefined), "default");
});

test("without contributor mode no twin is derived", async () => {
  const { ModelCatalog } = await import("../dist/muse/models.js");
  const { createLogger } = await import("../dist/config.js");
  const stubHost = {
    request: async () => ({
      models: [{ modelId: "muse-new-9.0", displayLabel: "M", contextLimit: 1, outputLimit: 1, variants: ["low"], isDefault: false }],
    }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-notwin-"));
  const cfg = config({ contributor: false, stateDir: dir });
  const catalog = new ModelCatalog(stubHost, cfg, createLogger(cfg));
  assert.deepEqual((await catalog.refresh()).map((m) => m.id), ["muse-new-9.0"]);
});

test("contributor twins are on by default, even before the first refresh", async () => {
  const { ModelCatalog, DEFAULT_MODELS } = await import("../dist/muse/models.js");
  const { createLogger, resolveConfig } = await import("../dist/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-default-"));
  const cfg = resolveConfig({ stateDir: dir });
  assert.equal(cfg.contributor, true);
  // Any server call here would be a bug: the twins come from the defaults.
  const stubHost = { request: async () => { throw new Error("must not refresh"); } };
  const catalog = new ModelCatalog(stubHost, cfg, createLogger(cfg));
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    [...DEFAULT_MODELS.map((m) => m.id), ...DEFAULT_MODELS.map((m) => `${m.id}-contributor`)].sort(),
  );
});

test("catalog is alphabetical, each model next to its contributor twin", async () => {
  const { ModelCatalog } = await import("../dist/muse/models.js");
  const { createLogger } = await import("../dist/config.js");
  const stubHost = {
    request: async () => ({
      models: [
        { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", contextLimit: 1, outputLimit: 1, variants: ["low"], isDefault: true },
        { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", contextLimit: 1, outputLimit: 1, variants: ["low"], isDefault: false },
      ],
    }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-sorted-"));
  const cfg = config({ contributor: true, stateDir: dir });
  const catalog = new ModelCatalog(stubHost, cfg, createLogger(cfg));
  assert.deepEqual((await catalog.refresh()).map((m) => m.id), [
    "muse-spark-1.2",
    "muse-spark-1.2-contributor",
    "muse-wonder-1.0",
    "muse-wonder-1.0-contributor",
  ]);
});

test("GET /v1/models refreshes a day-old cache so new models appear", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-stale-"));
  const cacheFile = path.join(dir, "models.json");
  fs.writeFileSync(cacheFile, JSON.stringify([{ id: "muse-old-1.0", name: "old", context: 1, output: 1, efforts: ["low"] }]));
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(cacheFile, past, past);
  const staleProxy = await startProxy(config({ stateDir: dir }));
  try {
    const res = await fetch(`${staleProxy.url}/models`);
    assert.equal(res.status, 200);
    const ids = (await res.json()).data.map((m) => m.id);
    assert.ok(!ids.includes("muse-old-1.0"), "stale cache was replaced");
    assert.ok(ids.includes("muse-spark-1.3"), "fresh server list is served");
  } finally {
    await staleProxy.close();
  }
});

test("streams a turn: text, reasoning, usage", async () => {
  const res = await chat({ messages: [{ role: "system", content: "OpenCode tools..." }, { role: "user", content: "hello" }] }, session("s-basic"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const out = await collect(res);
  assert.equal(out.content, "Muse heard: hello [images=0] [model=muse-spark-1.3] [effort=default]");
  assert.equal(out.reasoning, "Thinking about the request.");
  assert.equal(out.finish, "stop");
  assert.equal(out.usage.prompt_tokens, 70);
  assert.equal(out.usage.completion_tokens, 30);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 0);
  assert.ok(!out.reasoning.includes("Reminder"), "background reviewer items are not traced");
  assert.ok(out.done);
  assert.ok(!out.content.includes("OpenCode tools"), "system prompt is not forwarded by default");
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

test("responses echo the serving model, mode and effort in headers", async () => {
  const res = await chat(
    { stream: false, model: "muse/muse-spark-1.3-contributor", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
    session("s-headers"),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-open-muse-model"), "muse-spark-1.3-contributor");
  assert.equal(res.headers.get("x-open-muse-mode"), "contributor");
  assert.equal(res.headers.get("x-open-muse-reasoning-effort"), "high");
  const res2 = await chat({ stream: false, messages: [{ role: "user", content: "hi" }] }, session("s-headers-std"));
  assert.equal(res2.headers.get("x-open-muse-mode"), "standard");
  // The fake server reports high as this model's default effort.
  assert.equal(res2.headers.get("x-open-muse-reasoning-effort"), "high");
});

test("GET /v1/usage returns the subscription quota", async () => {
  const res = await fetch(`${proxy.url}/usage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "subscription_usage");
  assert.equal(body.data.window.usedPercent, 16);
  assert.equal(body.data.weekly.usedPercent, 46);
  assert.equal(body.data.window.windowDurationMins, 300);
});

test("readUsage returns null when the host observed nothing", async () => {
  const { readUsage } = await import("../dist/muse/usage.js");
  const { createLogger } = await import("../dist/config.js");
  const log = createLogger({ debug: false });
  assert.equal(await readUsage({ request: async () => ({}) }, log), null);
  assert.equal(await readUsage({ request: async () => { throw new Error("down"); } }, log), null);
  assert.equal(
    await readUsage({ request: async () => ({ usage: { weekly: {}, window: {} } }) }, log),
    null,
  );
});

test("a chat refreshes a stale catalog so the echoed effort is real", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-muse-fresh-effort-"));
  const freshProxy = await startProxy(config({ stateDir: dir }));
  try {
    const res = await chat(
      { stream: false, model: "muse/muse-spark-1.3", messages: [{ role: "user", content: "hi" }] },
      session("s-fresh-effort"),
      freshProxy.url,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-open-muse-reasoning-effort"), "high");
  } finally {
    await freshProxy.close();
  }
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

test("switching contributor modes starts a fresh session, same-mode switches reuse it", async () => {
  const history = [{ role: "user", content: "one" }];
  const starts = count("session/start");
  const sets = count("session/setModel");
  let out = await collect(await chat({ messages: history }, session("s-modes")));
  history.push({ role: "assistant", content: out.content }, { role: "user", content: "two" });
  // Standard -> contributor: a fresh session on the contributor host, no setModel.
  out = await collect(await chat({ model: "muse/muse-spark-1.3-contributor", messages: history }, session("s-modes")));
  assert.match(out.content, /model=muse-spark-1.3-contributor/);
  assert.equal(count("session/start") - starts, 2);
  assert.equal(count("session/setModel") - sets, 0);
  history.push({ role: "assistant", content: out.content }, { role: "user", content: "three" });
  // Contributor -> contributor: the session is reused via setModel.
  out = await collect(await chat({ model: "muse/muse-spark-1.2-contributor", messages: history }, session("s-modes")));
  assert.match(out.content, /model=muse-spark-1.2-contributor/);
  assert.equal(count("session/start") - starts, 2);
  assert.ok(count("session/setModel") - sets >= 1);
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
