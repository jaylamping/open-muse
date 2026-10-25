import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createLogger, type OpenMuseConfig, type Logger, type ApprovalPolicy } from "../config.js";
import { MuseHost, MuseHostError } from "../muse/host.js";
import { ModelCatalog, isContributorModel, resolveEffort } from "../muse/models.js";
import { pickUsage, readUsage } from "../muse/usage.js";
import { BadRequestError, SessionRouter } from "../muse/sessions.js";
import { createMcpHandler } from "./mcp.js";
import { createToolExecutor, type ToolExecutor } from "../opencode/tools.js";
import { runTurn, type MuseUsage, type MuseTurnError } from "../muse/turn.js";
import { type ChatMessage, digestUsers, localTitle, userMessages } from "../translate/messages.js";

export const HEADER_SESSION = "x-open-muse-session";
export const HEADER_AGENT = "x-open-muse-agent";
export const HEADER_DIRECTORY = "x-open-muse-directory";

/** OpenCode agents whose requests are one-off jobs, not turns in the user's conversation. */
const ONE_SHOT_AGENTS = new Set(["compaction", "summary", "generate"]);
/** OpenCode agents that should not change anything on disk. */
const READ_ONLY_AGENTS = new Set(["plan", "explore", "compaction", "summary", "generate"]);

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
}

export interface ProxyServer {
  readonly url: string;
  readonly port: number;
  readonly host: MuseHost;
  readonly catalog: ModelCatalog;
  close(): Promise<void>;
}

export async function startProxy(
  config: OpenMuseConfig,
  log: Logger = createLogger(config),
  toolExecutor?: ToolExecutor,
): Promise<ProxyServer> {
  // One host per contributor mode: `-contributor` models run with
  // `--contributor-mode on`, standard models with `off`. Each host spawns
  // lazily, so the unused one costs nothing. With `contributor: false` both
  // keep the legacy behavior (no flag, server list as-is, single mode).
  const dual = config.contributor;
  // The local read-only executor needs no OpenCode client; tests inject a stub.
  const bridge = config.tools ? (toolExecutor ?? createToolExecutor()) : undefined;
  const mcpCaps = bridge ? ["sessionMcp"] : undefined;
  const standardHost = new MuseHost(config, log, dual ? "off" : undefined, mcpCaps);
  const contributorHost = new MuseHost(config, log, dual ? "on" : undefined, mcpCaps);
  const hostFor = (modelId: string | undefined): MuseHost =>
    dual && isContributorModel(modelId) ? contributorHost : standardHost;
  const catalog = new ModelCatalog(standardHost, config, log, dual ? contributorHost : undefined);
  // Assigned after listen: the router and the MCP endpoint need the proxy URL.
  let router!: SessionRouter;
  let mcpHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | undefined;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.warn("request failed", error);
      if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "");
    if (req.method === "GET" && (route === "" || route === "/health")) {
      return sendJson(res, 200, { ok: true, name: "open-muse" });
    }
    if (req.method === "GET" && route === "/v1/usage") {
      // Subscription quota (5h window, weekly): cheap to read, no turn spent.
      // Each host only observes the turns it served, so merge both modes.
      const [standard, contributor] = await Promise.all([
        readUsage(standardHost, log),
        dual ? readUsage(contributorHost, log) : Promise.resolve(null),
      ]);
      return sendJson(res, 200, { object: "subscription_usage", data: pickUsage(standard, contributor) });
    }
    if (req.method === "GET" && route === "/v1/models") {
      // Refresh a day-old cache on demand, so a model that appears tomorrow
      // shows up without restarting. Never fails the listing.
      await catalog.refreshIfStale();
      return sendJson(res, 200, {
        object: "list",
        data: catalog.models.map((m) => ({ id: m.id, object: "model", owned_by: "muse", created: 0 })),
      });
    }
    if (req.method === "POST" && route === "/v1/chat/completions") {
      return chatCompletions(req, res);
    }
    if (mcpHandler && (route === "/mcp" || route.startsWith("/mcp/"))) {
      return mcpHandler(req, res);
    }
    sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
  }

  async function chatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Refresh a day-old cache so the echoed effort (and any new model) is
    // current even when the first interaction is a chat, not a listing.
    await catalog.refreshIfStale();
    let body: ChatRequestBody;
    try {
      body = JSON.parse(await readBody(req)) as ChatRequestBody;
    } catch {
      return sendError(res, 400, "Request body is not valid JSON.");
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const modelId = normalizeModel(body.model, config.providerId);
    // Echo back what served this turn (streaming and non-streaming alike),
    // since the real Muse reply never names its own model or effort.
    if (modelId) res.setHeader("x-open-muse-model", modelId);
    res.setHeader("x-open-muse-mode", isContributorModel(modelId) ? "contributor" : "standard");
    res.setHeader("x-open-muse-reasoning-effort", resolveEffort(catalog.models, modelId, body.reasoning_effort));
    const agent = header(req, HEADER_AGENT);
    const workspace = resolveWorkspace(header(req, HEADER_DIRECTORY));
    const key = header(req, HEADER_SESSION) ?? `anon:${workspace}:${digestUsers(userMessages(messages).slice(0, 1))}`;
    const stream = body.stream === true;
    const responseId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? modelId ?? "muse";

    // Session titles are cheap to make locally and would otherwise cost a Muse prompt each.
    if (agent === "title" && config.localTitles) {
      const title = localTitle(messages);
      return stream
        ? sendStream(res, responseId, created, model, [{ content: title }], "stop", undefined, body)
        : sendJson(res, 200, completion(responseId, created, model, title, "", "stop", undefined));
    }

    const ephemeral = agent !== undefined && ONE_SHOT_AGENTS.has(agent);
    const approvals: ApprovalPolicy = agent && READ_ONLY_AGENTS.has(agent) && config.approvals === "allow" ? "deny" : config.approvals;

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let prepared;
    try {
      prepared = await router.prepare({ key, workspace, messages, modelId, ephemeral });
    } catch (error) {
      return sendError(res, statusFor(error), messageFor(error));
    }

    let content = "";
    let reasoning = "";
    let usage: MuseUsage | undefined;
    let failure: MuseTurnError | undefined;
    let terminal = "completed";
    const writer = stream ? new SseWriter(res, responseId, created, model) : undefined;

    try {
      for await (const event of runTurn(prepared.host, {
        sessionId: prepared.museSessionId,
        input: prepared.input,
        reasoningEffort: body.reasoning_effort,
        approvals,
        signal: abort.signal,
        log,
      })) {
        prepared.commit();
        if (abort.signal.aborted) break;
        switch (event.type) {
          case "text":
            content += event.delta;
            writer?.delta({ content: event.delta });
            break;
          case "reasoning":
            reasoning += event.delta;
            writer?.delta({ reasoning_content: event.delta });
            break;
          case "tool": {
            if (config.toolDisplay === "hidden") break;
            const line = `${event.phase === "started" ? "▸" : "  ↳"} ${event.text}\n`;
            if (config.toolDisplay === "content") {
              content += line;
              writer?.delta({ content: line });
            } else {
              reasoning += line;
              writer?.delta({ reasoning_content: line });
            }
            break;
          }
          case "done":
            terminal = event.terminal;
            usage = event.usage;
            failure = event.error;
            break;
        }
      }
    } catch (error) {
      if (!writer?.started) return sendError(res, statusFor(error), messageFor(error));
      failure = { kind: "proxy", message: messageFor(error), retryable: false };
    } finally {
      prepared.release();
    }
    if (abort.signal.aborted) return void res.end();

    if (failure && terminal !== "cancelled") {
      const message = describeFailure(failure);
      // Before any output, a real HTTP error lets OpenCode show it properly (and retry 429s).
      if (writer?.started) return writer.error(message, failure.kind);
      return sendError(res, failureStatus(failure), message);
    }
    const finish = failure?.kind === "stepLimit" ? "length" : "stop";
    if (writer) return writer.finish(finish, usage, body.stream_options?.include_usage !== false);
    sendJson(res, 200, completion(responseId, created, model, content, reasoning, finish, usage));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://${config.host}:${port}`;
  const url = `${origin}/v1`;
  log.debug(`proxy listening on ${url}`);
  // The TUI quota footer reads this to find the proxy without any manual config.
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(config.stateDir, "proxy.json"),
      JSON.stringify({ url, origin, port, pid: process.pid, startedAtMs: Date.now() }),
    );
  } catch (error) {
    log.debug("proxy.json skipped:", error instanceof Error ? error.message : error);
  }
  router = new SessionRouter(hostFor, config, log, bridge ? { baseUrl: origin } : undefined);
  if (bridge) {
    const execute = bridge;
    mcpHandler = createMcpHandler(execute, (key) => router.workspaceFor(key), log);
  }

  return {
    url,
    port,
    host: standardHost,
    catalog,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await standardHost.close();
      await contributorHost.close();
    },
  };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.length > 0 ? v : undefined;
}

function normalizeModel(model: string | undefined, providerId: string): string | undefined {
  if (!model) return undefined;
  const prefix = `${providerId}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function resolveWorkspace(directory: string | undefined): string {
  if (directory) {
    const abs = path.resolve(directory);
    try {
      if (fs.statSync(abs).isDirectory()) return fs.realpathSync.native(abs);
    } catch {
      // fall through
    }
  }
  return fs.realpathSync.native(process.cwd());
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: "open_muse_error", code: status } });
}

function statusFor(error: unknown): number {
  if (error instanceof BadRequestError) return 400;
  if (error instanceof MuseHostError) return 503;
  return 500;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureStatus(error: MuseTurnError): number {
  if (error.kind === "authRequired") return 401;
  if (error.quota !== undefined || /quota|rate/i.test(error.kind)) return 429;
  return 502;
}

function describeFailure(error: MuseTurnError): string {
  if (error.kind === "authRequired") {
    return "Muse Code is not signed in. Run `muse login` in a terminal, then try again.";
  }
  if (error.quota !== undefined) {
    return `Muse Code usage limit reached for your plan: ${error.message}`;
  }
  return `Muse Code turn failed (${error.kind}): ${error.message}`;
}

function usageBlock(usage: MuseUsage | undefined) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

function completion(
  id: string,
  created: number,
  model: string,
  content: string,
  reasoning: string,
  finish: string,
  usage: MuseUsage | undefined,
) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: finish,
      },
    ],
    ...(usage ? { usage: usageBlock(usage) } : {}),
  };
}

function sendStream(
  res: http.ServerResponse,
  id: string,
  created: number,
  model: string,
  deltas: Record<string, string>[],
  finish: string,
  usage: MuseUsage | undefined,
  body: ChatRequestBody,
): void {
  const writer = new SseWriter(res, id, created, model);
  for (const d of deltas) writer.delta(d);
  writer.finish(finish, usage, body.stream_options?.include_usage !== false);
}

/** OpenAI-style `chat.completion.chunk` server-sent events. */
class SseWriter {
  started = false;
  #res: http.ServerResponse;
  #base: { id: string; object: string; created: number; model: string };

  constructor(res: http.ServerResponse, id: string, created: number, model: string) {
    this.#res = res;
    this.#base = { id, object: "chat.completion.chunk", created, model };
  }

  #start() {
    if (this.started) return;
    this.started = true;
    this.#res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    this.#write({ ...this.#base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  }

  #write(value: unknown) {
    this.#res.write(`data: ${JSON.stringify(value)}\n\n`);
  }

  delta(delta: Record<string, string>) {
    this.#start();
    this.#write({ ...this.#base, choices: [{ index: 0, delta, finish_reason: null }] });
  }

  finish(reason: string, usage: MuseUsage | undefined, includeUsage: boolean) {
    this.#start();
    this.#write({ ...this.#base, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    if (usage && includeUsage) this.#write({ ...this.#base, choices: [], usage: usageBlock(usage) });
    this.#res.end("data: [DONE]\n\n");
  }

  error(message: string, kind: string) {
    this.#start();
    this.#write({ error: { message, type: kind, code: kind } });
    this.#res.end("data: [DONE]\n\n");
  }
}
