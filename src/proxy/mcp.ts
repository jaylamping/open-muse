import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../config.js";
import { READONLY_TOOLS, type ToolExecutor } from "../opencode/tools.js";

const MAX_BODY = 1_000_000;

/** Resolve an MCP session key (the OpenCode conversation id) to its workspace. */
export type WorkspaceResolver = (key: string) => string | undefined;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** Same error shape as the proxy's own routes: `{ error: { message, type, code } }`. */
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: "open_muse_error", code: status } });
}

/**
 * One MCP-over-Streamable-HTTP endpoint multiplexed per OpenCode conversation:
 * `POST /mcp/<openCodeSessionKey>`. A fresh server + stateless transport is
 * built per request; the bridged tools run in OpenCode's process, so OpenCode
 * owns execution, permissions, and sandboxing.
 */
export function createMcpHandler(
  execute: ToolExecutor,
  resolveWorkspace: WorkspaceResolver,
  log: Logger,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const key = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/mcp\/?/, ""));
    if (!key) return sendError(res, 404, "missing MCP session key");

    const server = new McpServer({ name: "open-muse-tools", version: "0.1.0" });
    const run = (tool: string) => async (args: Record<string, unknown>) => {
      try {
        // Resolved per call: tools/list works before any turn ran, while
        // tools/call needs the conversation's workspace.
        const directory = resolveWorkspace(key);
        if (!directory) throw new Error(`unknown conversation: ${key}`);
        const text = await execute({ tool, args, directory }, log);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    };
    if (READONLY_TOOLS.includes("read")) {
      server.registerTool(
        "read",
        { description: "Read a file from the OpenCode workspace (OpenCode permissions apply).", inputSchema: { path: z.string() } },
        run("read"),
      );
    }
    if (READONLY_TOOLS.includes("grep")) {
      server.registerTool(
        "grep",
        { description: "Search file contents in the OpenCode workspace.", inputSchema: { pattern: z.string() } },
        run("grep"),
      );
    }
    if (READONLY_TOOLS.includes("glob")) {
      server.registerTool(
        "glob",
        { description: "Find files by name in the OpenCode workspace.", inputSchema: { query: z.string() } },
        run("glob"),
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
        if (Buffer.concat(chunks).length > MAX_BODY) return sendError(res, 413, "body too large");
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        return sendError(res, 400, "invalid MCP JSON body");
      }
      if (parsed === undefined) return sendError(res, 400, "empty MCP request body");
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      log.debug("mcp request failed", error instanceof Error ? error.message : error);
      if (!res.headersSent) sendError(res, 500, "mcp request failed");
      else res.end();
    } finally {
      await transport.close().catch(() => undefined);
    }
  };
}
