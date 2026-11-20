import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  FLOW_TOOL_ALIAS_HOST,
  FLOW_TOOL_BIND_HOST,
  FLOW_TOOL_MAX_BODY_BYTES,
  FLOW_TOOL_PATH,
  FLOW_TOOL_SERVER_NAME,
  FLOW_TOOL_TOKEN_BYTES,
} from "../../domain/constants";
import type { FlowControl } from "./control";
import { createFlowToolMcpServer, FLOW_TOOL_NAMES } from "./tools";

export interface ToolGrant {
  readonly token: string;
  readonly server: string;
  readonly url: string;
  readonly toolNames: readonly string[];
}

export interface FlowToolServer {
  readonly url: string;
  register(control: FlowControl): ToolGrant;
  revoke(token: string): void;
  close(): Promise<void>;
}

const BEARER_PREFIX = "Bearer ";
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const POST_METHOD = "POST";

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { Connection: "close" });
  response.end();
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith(BEARER_PREFIX) === true
    ? header.slice(BEARER_PREFIX.length)
    : null;
}

function declaredLength(request: IncomingMessage): number {
  return Number(request.headers["content-length"] ?? 0);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  if (declaredLength(request) > FLOW_TOOL_MAX_BODY_BYTES) {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      continue;
    }
    size += chunk.length;
    if (size > FLOW_TOOL_MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

type ParsedBody =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "rejected" };

async function parseBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<ParsedBody> {
  if (request.method !== POST_METHOD) {
    return { kind: "ok", value: undefined };
  }
  const body = await readBody(request);
  if (body === null) {
    reject(response, HTTP_PAYLOAD_TOO_LARGE);
    request.destroy();
    return { kind: "rejected" };
  }
  try {
    return { kind: "ok", value: JSON.parse(body.toString("utf8")) };
  } catch (error) {
    console.error(error);
    reject(response, HTTP_BAD_REQUEST);
    return { kind: "rejected" };
  }
}

async function serveMcp(
  resolveControl: () => FlowControl | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parsed = await parseBody(request, response);
  if (parsed.kind === "rejected") {
    return;
  }
  const control = resolveControl();
  if (control === undefined) {
    reject(response, HTTP_UNAUTHORIZED);
    return;
  }
  const mcp = createFlowToolMcpServer(control);
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  response.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response, parsed.value);
}

class LoopbackFlowToolServer implements FlowToolServer {
  url = "";
  private readonly controls = new Map<string, FlowControl>();
  private readonly allowedHosts = new Set<string>();
  private readonly http: Server;
  private closing: Promise<void> | null = null;

  constructor() {
    this.http = createServer((request, response) => {
      this.handle(request, response);
    });
    this.http.on("checkContinue", (request, response) => {
      this.handle(request, response);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, fail) => {
      this.http.once("error", fail);
      this.http.listen(0, FLOW_TOOL_BIND_HOST, () => {
        this.http.off("error", fail);
        const address = this.http.address();
        if (address === null || typeof address === "string") {
          fail(new Error("flow tool server has no TCP address"));
          return;
        }
        const port = String(address.port);
        this.allowedHosts.add(`${FLOW_TOOL_BIND_HOST}:${port}`);
        this.allowedHosts.add(`${FLOW_TOOL_ALIAS_HOST}:${port}`);
        this.url = `http://${FLOW_TOOL_BIND_HOST}:${port}${FLOW_TOOL_PATH}`;
        resolve();
      });
    });
  }

  register(control: FlowControl): ToolGrant {
    const token = randomBytes(FLOW_TOOL_TOKEN_BYTES).toString("base64url");
    this.controls.set(token, control);
    return {
      token,
      server: FLOW_TOOL_SERVER_NAME,
      url: this.url,
      toolNames: FLOW_TOOL_NAMES,
    };
  }

  revoke(token: string): void {
    this.controls.delete(token);
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((done, fail) => {
      this.http.close((error) => {
        if (error === undefined) {
          done();
          return;
        }
        fail(error);
      });
      this.http.closeAllConnections();
    });
    return this.closing;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.route(request, response).catch((error: unknown) => {
      console.error(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      reject(response, HTTP_INTERNAL_ERROR);
    });
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.allowedHosts.has(request.headers.host ?? "")) {
      reject(response, HTTP_FORBIDDEN);
      return;
    }
    if (request.url?.split("?")[0] !== FLOW_TOOL_PATH) {
      reject(response, HTTP_NOT_FOUND);
      return;
    }
    const token = bearerToken(request);
    const resolveControl = (): FlowControl | undefined =>
      token === null ? undefined : this.controls.get(token);
    if (resolveControl() === undefined) {
      reject(response, HTTP_UNAUTHORIZED);
      return;
    }
    if (request.headers.expect !== undefined) {
      response.writeContinue();
    }
    await serveMcp(resolveControl, request, response);
  }
}

export async function startFlowToolServer(): Promise<FlowToolServer> {
  const server = new LoopbackFlowToolServer();
  await server.listen();
  return server;
}
