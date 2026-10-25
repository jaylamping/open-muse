// A scripted stand-in for `muse serve`: JSON-RPC 2.0 over stdio, one frame per line,
// shaped like the Muse Session Protocol. Every request is appended to $FAKE_MUSE_LOG.
import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";

const LOG = process.env.FAKE_MUSE_LOG;
let cursor = 0;
const nextCursor = () => `c${String(++cursor).padStart(6, "0")}`;
const sessions = new Map(); // sessionId -> { modelId }
const pendingApprovals = new Map(); // approvalId -> resolve(decision)
const pendingCancels = new Map(); // turnId -> resolve()

const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const notify = (method, params) => send({ method, params: { ...params, viewCursor: nextCursor() } });
const range = { start: cursor, end: cursor };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(entry) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method) log({ method: msg.method, params: msg.params });
  if (msg.id === undefined) return; // notification (e.g. `initialized`)
  handle(msg).catch((error) => send({ id: msg.id, error: { code: -32603, message: String(error), data: { kind: "internal" } } }));
});
rl.on("close", () => process.exit(0));

async function handle({ id, method, params = {} }) {
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          experimentalApi: false,
          grantedCapabilities: [],
          museHome: "/tmp/fake-muse-home",
          platformFamily: "unix",
          platformOs: "linux",
          schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT },
          serverInfo: { name: "fake-muse", version: "1.4.6" },
          sessionDurability: "durable",
          userAgent: "fake-muse/1.4.6",
        },
      });
    case "usage/read":
      return send({
        id,
        result: {
          usage: {
            observedAtMs: 1,
            tier: "fake-tier",
            weekly: { resetsAtMs: 2, usedPercent: 46 },
            window: { resetsAtMs: 3, usedPercent: 16, windowDurationMins: 300 },
          },
        },
      });
    case "model/list":
      return send({
        id,
        result: {
          providerId: "meta",
          profileId: null,
          source: "fake",
          models: [
            { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", contextLimit: 1048576, outputLimit: 131072, isDefault: true, isActive: false, variants: ["low", "medium", "high"], defaultReasoningEffort: "high", cost: null, description: null, profileId: null, providerId: "meta", releaseDate: null },
            { modelId: "muse-spark-1.3-contributor", displayLabel: "Muse Spark 1.3 (contributor)", contextLimit: 1048576, outputLimit: 131072, isDefault: false, isActive: false, variants: ["low", "medium", "high"], defaultReasoningEffort: "high", cost: null, description: null, profileId: null, providerId: "meta", releaseDate: null },
          ],
        },
      });
    case "session/start": {
      const sessionId = randomUUID();
      sessions.set(sessionId, { modelId: params.modelId ?? "muse-spark-1.3" });
      const session = { sessionId, workspaceRoot: params.workspaceRoot, status: "idle", activeTurnId: null, createdAt: new Date().toISOString() };
      send({ id, result: { session, viewCursor: nextCursor() } });
      return send({ method: "session/started", params: { session } });
    }
    case "session/resume": {
      if (!sessions.has(params.sessionId) && !params.sessionId.startsWith("persisted-")) {
        return send({ id, error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } } });
      }
      sessions.set(params.sessionId, sessions.get(params.sessionId) ?? { modelId: "muse-spark-1.3" });
      return send({ id, result: { session: { sessionId: params.sessionId, status: "idle", activeTurnId: null }, viewCursor: nextCursor(), history: { mode: "none" }, pendingRequests: [] } });
    }
    case "session/setModel":
      sessions.get(params.sessionId).modelId = params.model.modelId;
      return send({ id, result: { commandId: params.commandId, status: "accepted" } });
    case "approval/decide": {
      send({ id, result: { approvalId: params.approvalId, commandId: params.commandId, status: "accepted", terminal: true } });
      pendingApprovals.get(params.approvalId)?.(params.choiceId);
      return;
    }
    case "turn/cancel": {
      send({ id, result: { commandId: params.commandId, status: "accepted", turnId: params.turnId } });
      pendingCancels.get(params.turnId)?.();
      return;
    }
    case "turn/start": {
      const turnId = params.commandId;
      send({ id, result: { commandId: params.commandId, status: "accepted", turnId, disposition: "started" } });
      void runScript(params.sessionId, turnId, params);
      return;
    }
    default:
      return send({ id, error: { code: -32601, message: `fake-muse: no ${method}`, data: { kind: "methodNotFound" } } });
  }
}

async function runScript(sessionId, turnId, params) {
  const text = params.input.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const images = params.input.filter((p) => p.type === "image").length;
  const base = { sessionId };
  notify("turn/started", { ...base, turnId });
  await sleep(5);

  if (text.includes("FAIL_AUTH")) {
    return notify("turn/completed", { ...base, turnId, terminal: "failed", sourceRange: range, error: { kind: "authRequired", message: "no credential", retryable: false } });
  }

  // Reasoning summary, streamed.
  const reasoningId = randomUUID();
  notify("item/started", { ...base, item: { itemId: reasoningId, kind: "reasoning", status: "inProgress", revision: 1, turnId, summary: [] } });
  notify("item/delta", { ...base, itemId: reasoningId, field: "summary.0", delta: "Thinking about " });
  notify("item/delta", { ...base, itemId: reasoningId, field: "summary.0", delta: "the request." });
  notify("item/completed", { ...base, sourceRange: range, item: { itemId: reasoningId, kind: "reasoning", status: "completed", revision: 2, turnId, summary: ["Thinking about the request."] } });

  if (text.includes("SLOW")) {
    await new Promise((resolve) => {
      pendingCancels.set(turnId, resolve);
      setTimeout(resolve, 10_000);
    });
    return notify("turn/completed", { ...base, turnId, terminal: "cancelled", sourceRange: range });
  }

  if (text.includes("USE_TOOL")) {
    const toolId = randomUUID();
    const approvalId = randomUUID();
    const toolItem = { itemId: toolId, kind: "toolCall", status: "inProgress", revision: 1, turnId, tool: "bash", args: JSON.stringify({ command: "npm test" }) };
    notify("item/started", { ...base, item: toolItem });
    const decision = new Promise((resolve) => pendingApprovals.set(approvalId, resolve));
    notify("approval/requested", {
      ...base, approvalId, turnId, itemId: toolId, toolCallId: "call_1", toolName: "bash", taskId: toolId,
      rawArgs: toolItem.args, judgeEscalated: false, protectedWrite: false, sourceRange: range,
      subject: { kind: "command" }, currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: [
        { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" },
        { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Allow for session" },
        { choiceId: "deny", decision: "denied", scope: "once", label: "Deny", acceptsFeedback: true },
      ],
    });
    const choice = await decision;
    const approved = choice !== "deny";
    notify("item/completed", { ...base, sourceRange: range, item: { ...toolItem, revision: 2, status: approved ? "completed" : "rejected", failureReason: approved ? undefined : "denied by user" } });
  }

  // The reply echoes what the agent received, so tests can assert on prompt construction.
  const replyId = randomUUID();
  const reply = `Muse heard: ${text} [images=${images}] [model=${sessions.get(sessionId)?.modelId}] [effort=${params.reasoningEffort ?? "default"}]`;
  notify("item/started", { ...base, item: { itemId: replyId, kind: "agentMessage", status: "inProgress", revision: 1, turnId, text: "" } });
  const half = Math.floor(reply.length / 2);
  notify("item/delta", { ...base, itemId: replyId, delta: reply.slice(0, half) });
  // Deliberately drop the second delta: the completed item must fill in the remainder.
  notify("item/completed", { ...base, sourceRange: range, item: { itemId: replyId, kind: "agentMessage", status: "completed", revision: 2, turnId, text: reply } });
  // Like muse 1.4: a background reviewer item, and usage per model call (not on turn/completed).
  const reminderId = randomUUID();
  notify("item/started", { ...base, item: { itemId: reminderId, kind: "reminderChild", status: "inProgress", revision: 1, turnId, fallbackText: "Reminder child session" } });
  notify("item/completed", { ...base, sourceRange: range, item: { itemId: reminderId, kind: "reminderChild", status: "completed", revision: 2, turnId, fallbackText: "Reminder child session" } });
  for (const usage of [
    { inputTokens: 70, outputTokens: 10, cachedTokens: 0, reasoningTokens: 2 },
    { inputTokens: 50, outputTokens: 20, cachedTokens: 20, reasoningTokens: 3 },
  ]) {
    notify("session/tokenUsage", { ...base, turnId, modelId: sessions.get(sessionId)?.modelId, usage, promptTokens: usage.inputTokens, totalTokens: usage.inputTokens + usage.outputTokens, sourceRange: range, cumulative: {} });
  }
  notify("turn/foregroundCompleted", { ...base, turnId, blockingAgents: ["reviewer"], sourceRange: range });
  notify("turn/completed", { ...base, turnId, terminal: "completed", sourceRange: range });
}
