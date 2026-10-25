import fs from "node:fs";
import path from "node:path";
import type { MuseHost } from "./host.js";
import type { TurnInputPart } from "./turn.js";
import type { OpenMuseConfig, Logger } from "../config.js";
import {
  type ChatMessage,
  digestUsers,
  renderHistory,
  systemPrompt,
  toTurnInput,
  userMessages,
} from "../translate/messages.js";
import { isContributorModel } from "./models.js";

interface Mapping {
  museSessionId: string;
  workspace: string;
  /** How many OpenCode user messages Muse has already seen in this session. */
  consumedUsers: number;
  digest: string;
  modelId?: string;
  updatedAt: number;
}

export interface PrepareRequest {
  /** Conversation identity: the OpenCode session id when the plugin supplies it. */
  key: string;
  workspace: string;
  messages: ChatMessage[];
  modelId?: string;
  /** One-off request (compaction/summary agents): fresh session, never remembered. */
  ephemeral?: boolean;
}

export interface PreparedTurn {
  museSessionId: string;
  /** The host owning this Muse session: turns must run against it. */
  host: MuseHost;
  input: TurnInputPart[];
  /** Record that Muse accepted this turn's message, so the next request sends only what's new. */
  commit(): void;
  release(): void;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Maps OpenCode conversations onto long-lived Muse sessions.
 *
 * OpenCode resends the full history on every request, but a Muse session keeps
 * its own history, so each request is diffed against what Muse has already
 * seen: one new user message is sent as-is; anything else (edited/reverted
 * history, compaction, a lost mapping) starts a fresh Muse session seeded with
 * a rendering of the earlier conversation.
 */
export interface RouterTools {
  /** Base URL of the proxy serving the per-conversation MCP endpoint. */
  baseUrl: string;
}

export class SessionRouter {
  #hostFor: (modelId: string | undefined) => MuseHost;
  #config: OpenMuseConfig;
  #log: Logger;
  #tools?: RouterTools;
  #file: string;
  #mappings = new Map<string, Mapping>();
  #locks = new Map<string, Promise<void>>();

  constructor(hostFor: (modelId: string | undefined) => MuseHost, config: OpenMuseConfig, log: Logger, tools?: RouterTools) {
    this.#hostFor = hostFor;
    this.#config = config;
    this.#log = log;
    this.#tools = tools;
    this.#file = path.join(config.stateDir, "sessions.json");
    this.#load();
  }

  async prepare(request: PrepareRequest): Promise<PreparedTurn> {
    const release = await this.#lock(request.key);
    try {
      return { ...(await this.#prepare(request)), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async #prepare(request: PrepareRequest): Promise<Omit<PreparedTurn, "release">> {
    const users = userMessages(request.messages);
    const last = users.at(-1);
    if (!last) throw new BadRequestError("No user message to send to Muse.");

    const mapping = request.ephemeral ? undefined : this.#mappings.get(request.key);
    const commitFor = (museSessionId: string) => () => {
      if (request.ephemeral) return;
      // Always remembered in memory (so the MCP endpoint can route by
      // conversation key); persisted across restarts only for real
      // conversations, never for one-off jobs.
      this.#mappings.set(request.key, {
        museSessionId,
        workspace: request.workspace,
        consumedUsers: users.length,
        digest: digestUsers(users),
        modelId: request.modelId,
        updatedAt: Date.now(),
      });
      if (!request.ephemeral) this.#save();
    };

    if (
      mapping &&
      mapping.workspace === request.workspace &&
      this.#continues(mapping, users) &&
      sameMode(mapping.modelId, request.modelId)
    ) {
      const ready = await this.#reattach(mapping, request.modelId);
      if (ready) {
        const host = this.#hostFor(mapping.modelId);
        this.#log.debug("continuing muse session", mapping.museSessionId);
        return { museSessionId: mapping.museSessionId, host, input: toTurnInput(last), commit: once(commitFor(mapping.museSessionId)) };
      }
    }

    // Fresh session, seeded with whatever came before the newest user message.
    const lastIndex = request.messages.lastIndexOf(last);
    const prefix: string[] = [];
    if (this.#config.forwardSystemPrompt) {
      const system = systemPrompt(request.messages);
      if (system) prefix.push(`<system_instructions>\n${system}\n</system_instructions>`);
    }
    const history = renderHistory(request.messages.slice(0, lastIndex));
    if (history) prefix.push(history);

    const host = this.#hostFor(request.modelId);
    const museSessionId = await this.#start(host, request.key, request.workspace, request.modelId);
    this.#log.debug("started muse session", museSessionId, mapping ? "(history diverged)" : "");
    return { museSessionId, host, input: toTurnInput(last, prefix.join("\n\n")), commit: once(commitFor(museSessionId)) };
  }

  /** True when the request is the conversation Muse has, plus exactly one new user message (or a retry of the last). */
  #continues(mapping: Mapping, users: ChatMessage[]): boolean {
    if (users.length === mapping.consumedUsers + 1) return digestUsers(users.slice(0, -1)) === mapping.digest;
    if (users.length === mapping.consumedUsers) return digestUsers(users) === mapping.digest;
    return false;
  }

  async #reattach(mapping: Mapping, modelId: string | undefined): Promise<boolean> {
    const id = mapping.museSessionId;
    const host = this.#hostFor(mapping.modelId);
    try {
      if (!host.isLoaded(id)) {
        await host.command("session/resume", { sessionId: id, excludeItems: true });
        host.markLoaded(id);
      }
      if (modelId && modelId !== mapping.modelId) {
        await host.command("session/setModel", { sessionId: id, model: { modelId } });
      }
      return true;
    } catch (error) {
      this.#log.debug("could not reattach muse session", id, error);
      return false;
    }
  }

  /** Workspace of a known conversation key (OpenCode session id), for MCP routing. */
  workspaceFor(key: string): string | undefined {
    return this.#mappings.get(key)?.workspace;
  }

  async #start(host: MuseHost, key: string, workspace: string, modelId: string | undefined): Promise<string> {
    const params: Record<string, unknown> = { workspaceRoot: workspace };
    if (modelId) params.modelId = modelId;
    if (this.#tools) {
      params.config = {
        mcpServers: {
          "open-muse-tools": {
            transport: "streamableHttp",
            url: `${this.#tools.baseUrl}/mcp/${encodeURIComponent(key)}`,
            mode: "optional",
          },
        },
      };
    }
    const result = await host.command("session/start", params);
    const session = result.session as { sessionId?: string } | undefined;
    if (!session?.sessionId) throw new Error("muse serve did not return a session id");
    host.markLoaded(session.sessionId);
    return session.sessionId;
  }

  async #lock(key: string): Promise<() => void> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => current);
    this.#locks.set(key, chained);
    await previous;
    return once(() => {
      release();
      if (this.#locks.get(key) === chained) this.#locks.delete(key);
    });
  }

  #load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Record<string, Mapping>;
      const cutoff = Date.now() - MAX_AGE_MS;
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value.museSessionId === "string" && value.updatedAt > cutoff) this.#mappings.set(key, value);
      }
    } catch {
      // No saved state yet, or unreadable: start empty.
    }
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#mappings), null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      this.#log.debug("could not save session map", error);
    }
  }
}

export class BadRequestError extends Error {}

/** A Muse session cannot move between hosts: switching the contributor mode
 * starts a fresh session seeded with the transcript, like edited history. */
function sameMode(a: string | undefined, b: string | undefined): boolean {
  return isContributorModel(a) === isContributorModel(b);
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
