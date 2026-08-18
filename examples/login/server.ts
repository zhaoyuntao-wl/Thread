#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LoginService } from "./auth.js";
import { FileSecurityStateStore, FileUserStore } from "./store.js";

// 零依赖登录 API：node:http 实现，JWT Bearer 鉴权（延续 HS256 方案），
// 面向 MCP/API 客户端（非浏览器），与 cli.ts 共享同一个 LoginService。
export function createLoginServer(service: LoginService): Server {
  return createServer((req, res) => {
    void handle(req, res, service);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: LoginService,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";
  try {
    if (method === "POST" && path === "/register") {
      await register(req, res, service);
    } else if (method === "POST" && path === "/login") {
      await login(req, res, service);
    } else if (method === "POST" && path === "/logout") {
      await logout(req, res, service);
    } else if (method === "GET" && path === "/me") {
      await me(req, res, service);
    } else if (method === "POST" && path === "/change-password") {
      await changePassword(req, res, service);
    } else {
      json(res, 404, { error: "not-found" });
    }
  } catch {
    json(res, 500, { error: "internal" });
  }
}

async function register(req: IncomingMessage, res: ServerResponse, service: LoginService): Promise<void> {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "invalid-json" });
  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return json(res, 400, { error: "invalid-body" });
  }
  const result = service.register(username, password);
  if ("error" in result) return json(res, 400, { error: result.error });
  // 不返回 passwordHash：只回显可公开字段
  json(res, 201, { id: result.id, username: result.username, createdAt: result.createdAt });
}

async function login(req: IncomingMessage, res: ServerResponse, service: LoginService): Promise<void> {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "invalid-json" });
  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return json(res, 400, { error: "invalid-body" });
  }
  const result = service.login(username, password);
  if (!result.ok) return json(res, 401, { reason: result.reason });
  json(res, 200, { token: result.token });
}

async function logout(req: IncomingMessage, res: ServerResponse, service: LoginService): Promise<void> {
  const token = bearerToken(req);
  if (!token) return json(res, 401, { error: "unauthorized" });
  service.logout(token);
  res.writeHead(204).end();
}

async function me(req: IncomingMessage, res: ServerResponse, service: LoginService): Promise<void> {
  const token = bearerToken(req);
  const payload = token ? service.authenticate(token) : null;
  if (!payload) return json(res, 401, { error: "unauthorized" });
  json(res, 200, { sub: payload.sub, username: payload.username, iat: payload.iat, exp: payload.exp });
}

async function changePassword(
  req: IncomingMessage,
  res: ServerResponse,
  service: LoginService,
): Promise<void> {
  const token = bearerToken(req);
  const payload = token ? service.authenticate(token) : null;
  if (!payload) return json(res, 401, { error: "unauthorized" });
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "invalid-json" });
  const { oldPassword, newPassword } = body;
  if (typeof oldPassword !== "string" || typeof newPassword !== "string") {
    return json(res, 400, { error: "invalid-body" });
  }
  const result = service.changePassword(payload.username, oldPassword, newPassword);
  if (!result.ok) return json(res, 400, { reason: result.reason });
  json(res, 200, { ok: true });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface CliArgs {
  root: string;
  secret: string;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: join(tmpdir(), "thread-login-demo"),
    secret: "dev-secret-change-me",
    port: 8787,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--root":
        args.root = argv[++i] ?? args.root;
        break;
      case "--secret":
        args.secret = argv[++i] ?? args.secret;
        break;
      case "--port":
        args.port = Number(argv[++i]) || args.port;
        break;
      case "--help":
        console.log(`用法: npx tsx examples/login/server.ts [选项]

零依赖登录 API 演示（JWT HS256 + Bearer 鉴权）。
用户与安全状态分别持久化在 <root>/users.json 与 <root>/security.json。

选项:
  --root <dir>          数据目录（默认系统临时目录下 thread-login-demo）
  --secret <secret>     JWT 签名密钥（生产环境必须替换）
  --port <port>         监听端口（默认 8787）`);
        process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const usersFile = join(args.root, "users.json");
  const stateFile = join(args.root, "security.json");
  const service = new LoginService(args.secret, {
    store: new FileUserStore(usersFile),
    stateStore: new FileSecurityStateStore(stateFile),
  });
  const server = createLoginServer(service);
  server.listen(args.port, () => {
    console.log(`登录 API 演示（JWT HS256，数据目录 ${args.root}）

  POST /register        {username, password}
  POST /login           {username, password} -> {token}
  GET  /me              Authorization: Bearer <token>
  POST /logout          Authorization: Bearer <token>
  POST /change-password {oldPassword, newPassword} + Bearer

监听 http://127.0.0.1:${args.port}，Ctrl+C 退出`);
  });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) main();
