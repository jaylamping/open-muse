import type { MuseHost, MspNotification } from "./host.js";
import type { ApprovalPolicy, Logger } from "../config.js";

export interface MuseUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface MuseTurnError {
  kind: string;
  message: string;
  retryable: boolean;
  /** Present when the turn stopped on a plan usage limit. */
  quota?: unknown;
}

/** What one Muse turn looks like to the OpenAI layer. */
export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool"; phase: "started" | "completed"; text: string }
  | { type: "done"; terminal: string; usage?: MuseUsage; error?: MuseTurnError };

export interface TurnInputPart {
  type: "text" | "image";
  text?: string;
  base64Data?: string;
  mediaType?: string;
}

export interface RunTurnOptions {
  sessionId: string;
  input: TurnInputPart[];
  reasoningEffort?: string;
  approvals: ApprovalPolicy;
  signal?: AbortSignal;
  log: Logger;
}

interface ItemShape {
  itemId: string;
  kind: string;
  status?: string;
  turnId?: string | null;
  text?: string;
  summary?: string[];
  tool?: string;
  args?: string;
  failureReason?: string;
  fallbackText?: string;
}

interface ApprovalChoice {
  choiceId: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
}

/**
 * Item kinds not worth a trace line: the user's own message, reasoning (streamed
 * separately), and Muse's internal bookkeeping — `reminderChild` is a background
 * reviewer that fires several times per turn.
 */
const QUIET_KINDS = new Set(["userMessage", "reasoning", "reminderChild", "hookRun", "compaction"]);

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * Start a turn and stream its events until `turn/completed`.
 *
 * Notifications are buffered from before `turn/start` is sent: the host may push
 * `turn/started` and the first items in the same read as the ack, before we know
 * our turnId. Items are matched to the turn by `item.turnId`; deltas carry only
 * an itemId, so they are matched through the items we've already accepted.
 */
export async function* runTurn(host: MuseHost, options: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const { sessionId, log } = options;
  const queue: MspNotification[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = host.subscribe((n) => {
    const sid = n.params?.sessionId;
    if (sid !== undefined && sid !== sessionId) return;
    queue.push(n);
    wake?.();
  });

  let turnId: string | undefined;
  let cancelSent = false;
  const sendCancel = () => {
    if (cancelSent || !turnId) return;
    cancelSent = true;
    host.command("turn/cancel", { sessionId, turnId }).catch((e) => log.debug("turn/cancel failed", e));
  };
  const onAbort = () => {
    sendCancel();
    wake?.();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const params: Record<string, unknown> = { sessionId, input: options.input, ifBusy: "replace" };
    if (options.reasoningEffort && EFFORTS.has(options.reasoningEffort)) params.reasoningEffort = options.reasoningEffort;
    const ack = await host.command("turn/start", params);
    turnId = String(ack.turnId);
    log.debug("turn accepted", turnId, ack.disposition);
    if (options.signal?.aborted) sendCancel();

    const items = new Map<string, ItemShape>();
    const streamed = new Map<string, string>(); // itemId/field -> text already emitted
    const decided = new Set<string>();
    let usage: MuseUsage | undefined;
    let lastTextItem: string | undefined;
    let lastReasoningPart: string | undefined;

    const emitText = function* (itemId: string, delta: string): Generator<TurnEvent> {
      if (!delta) return;
      // Separate distinct assistant messages within one turn (e.g. before and after a tool run).
      if (lastTextItem && lastTextItem !== itemId) yield { type: "text", delta: "\n\n" };
      lastTextItem = itemId;
      yield { type: "text", delta };
    };
    const emitReasoning = function* (key: string, delta: string): Generator<TurnEvent> {
      if (!delta) return;
      if (lastReasoningPart && lastReasoningPart !== key) yield { type: "reasoning", delta: "\n\n" };
      lastReasoningPart = key;
      yield { type: "reasoning", delta };
    };
    const record = (key: string, delta: string) => streamed.set(key, (streamed.get(key) ?? "") + delta);
    /** On completion, emit whatever the deltas missed (the completed item is authoritative). */
    const remainder = (key: string, full: string | undefined): string => {
      if (!full) return "";
      const seen = streamed.get(key) ?? "";
      if (full.startsWith(seen)) {
        streamed.set(key, full);
        return full.slice(seen.length);
      }
      return "";
    };

    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        continue;
      }
      const n = queue.shift()!;
      const p = (n.params ?? {}) as Record<string, any>;

      switch (n.method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = p.item as ItemShape | undefined;
          if (!item || item.turnId !== turnId) break;
          const first = !items.has(item.itemId);
          items.set(item.itemId, item);
          if (item.kind === "agentMessage") {
            yield* emitText(item.itemId, remainder(`${item.itemId}/text`, item.text));
          } else if (item.kind === "reasoning" && n.method === "item/completed") {
            for (let i = 0; i < (item.summary ?? []).length; i++) {
              const key = `${item.itemId}/summary.${i}`;
              yield* emitReasoning(key, remainder(key, item.summary![i]));
            }
          } else if (item.kind === "toolCall") {
            if (first) yield { type: "tool", phase: "started", text: describeTool(item) };
            if (n.method === "item/completed") yield { type: "tool", phase: "completed", text: describeToolResult(item) };
          } else if (!QUIET_KINDS.has(item.kind) && n.method === "item/completed") {
            const text = item.fallbackText ?? `${item.kind} ${item.status ?? ""}`.trim();
            yield { type: "tool", phase: "completed", text };
          }
          break;
        }
        case "item/delta": {
          const item = items.get(p.itemId);
          if (!item) break;
          const field: string = p.field ?? "text";
          const delta = String(p.delta ?? "");
          const key = `${item.itemId}/${field}`;
          if (item.kind === "agentMessage" && field === "text") {
            record(key, delta);
            yield* emitText(item.itemId, delta);
          } else if (item.kind === "reasoning" && field.startsWith("summary.")) {
            record(key, delta);
            yield* emitReasoning(key, delta);
          }
          break;
        }
        case "approval/requested":
        case "approval/updated": {
          if (p.turnId && p.turnId !== turnId) break;
          const approvalId = String(p.approvalId);
          const requirement = p.currentRequirementId ?? { approvalId, sourceIndex: 0 };
          const stageKey = `${approvalId}#${requirement.sourceIndex}`;
          if (decided.has(stageKey) || !Array.isArray(p.availableChoices)) break;
          decided.add(stageKey);
          const choice = pickChoice(p.availableChoices as ApprovalChoice[], options.approvals);
          if (!choice) {
            log.debug("leaving approval to the host's default", approvalId);
            break;
          }
          const feedback =
            options.approvals === "deny" && choice.acceptsFeedback
              ? "open-muse is in read-only mode for this agent; do not modify files or run side-effecting commands."
              : null;
          host
            .command("approval/decide", { sessionId, approvalId, requirementId: requirement, choiceId: choice.choiceId, feedback })
            .catch((e) => log.warn("approval/decide failed", e));
          const verb = choice.decision.startsWith("approved") ? "auto-approved" : "denied";
          yield { type: "tool", phase: "started", text: `${verb}: ${p.toolName ?? "tool"}` };
          break;
        }
        case "session/tokenUsage": {
          // One per model call; muse 1.4 doesn't put the aggregate on turn/completed.
          // Every call re-sends the context so far, so summing inputs counts the
          // shared prefix once per call. Report the peak call's input as the
          // context this turn was actually holding, and sum what was generated.
          if (p.turnId !== turnId || !p.usage) break;
          const u = normalizeUsage(p.usage);
          usage = {
            inputTokens: Math.max(usage?.inputTokens ?? 0, u.inputTokens),
            outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens,
            cachedTokens: u.inputTokens >= (usage?.inputTokens ?? 0) ? u.cachedTokens : (usage?.cachedTokens ?? 0),
            reasoningTokens: (usage?.reasoningTokens ?? 0) + u.reasoningTokens,
          };
          break;
        }
        case "turn/completed": {
          if (p.turnId !== turnId) break;
          yield {
            type: "done",
            terminal: String(p.terminal),
            usage: p.usage ? normalizeUsage(p.usage) : usage,
            error: p.error ?? (p.terminal === "failed" ? { kind: "failed", message: p.reason ?? "turn failed", retryable: false } : undefined),
          };
          return;
        }
        case "turn/unqueued": {
          if (p.turnId !== turnId) break;
          yield { type: "done", terminal: "cancelled" };
          return;
        }
        case "open-muse/hostExited": {
          yield {
            type: "done",
            terminal: "failed",
            error: { kind: "hostExited", message: "The muse serve process exited during the turn.", retryable: true },
          };
          return;
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

function pickChoice(choices: ApprovalChoice[], policy: ApprovalPolicy): ApprovalChoice | undefined {
  if (policy === "host") return undefined;
  if (policy === "deny") return choices.find((c) => c.decision === "denied") ?? choices.find((c) => c.decision.startsWith("denied"));
  return (
    choices.find((c) => c.decision === "approved" && c.scope === "once") ??
    choices.find((c) => c.decision === "approved") ??
    choices.find((c) => c.decision.startsWith("approved"))
  );
}

function normalizeUsage(u: Record<string, unknown>): MuseUsage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cachedTokens: n(u.cachedTokens),
    reasoningTokens: n(u.reasoningTokens),
  };
}

const ARG_KEYS = ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url", "glob"];

export function describeTool(item: ItemShape): string {
  const name = item.tool ?? "tool";
  let detail = "";
  if (item.args) {
    try {
      const args = JSON.parse(item.args) as Record<string, unknown>;
      const key = ARG_KEYS.find((k) => typeof args[k] === "string" && args[k] !== "");
      detail = key ? String(args[key]) : JSON.stringify(args);
    } catch {
      detail = item.args;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 120) detail = `${detail.slice(0, 117)}...`;
  return detail ? `${name}: ${detail}` : name;
}

function describeToolResult(item: ItemShape): string {
  const name = item.tool ?? "tool";
  if (item.status === "completed") return `${name} done`;
  return `${name} ${item.status ?? "ended"}${item.failureReason ? `: ${item.failureReason}` : ""}`;
}
