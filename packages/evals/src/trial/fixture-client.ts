// agent 侧的唯一入口：一条命令 → 一行 JSON 响应（spec D4）。
// 用法（shell 友好，避免引号被 shell 吃掉）：
//   node dist/trial/fixture-client.js status
//   node dist/trial/fixture-client.js begin mode=immediate timeoutMs=0
//   node dist/trial/fixture-client.js read | write | commit | rollback | timeline
// 也接受单个 JSON 参数：node dist/trial/fixture-client.js '{"cmd":"read"}'
// 地址从 $TRIAL_FIXTURE_DIR/addr.txt 读；始终以 0 退出，结果按 JSON 判读。
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reply = (payload: unknown): never => {
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload));
  process.exit(0);
};

const fixtureDir = process.env.TRIAL_FIXTURE_DIR ?? "";
if (fixtureDir.length === 0) {
  reply({ ok: false, error: "TRIAL_FIXTURE_DIR is not set" });
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  reply({ ok: false, error: "usage: fixture-client.js <cmd> [key=value ...]  (cmds: begin read write rollback commit status timeline)" });
}

let request: string;
if (argv.join(" ").trim().startsWith("{")) {
  request = argv.join(" ");
} else {
  const [cmd, ...pairs] = argv;
  const payload: Record<string, unknown> = { cmd };
  for (const pair of pairs) {
    const [key, raw] = pair.split("=");
    if (key === undefined || raw === undefined) {
      reply({ ok: false, error: `bad argument ${JSON.stringify(pair)}; use key=value` });
    }
    payload[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  request = JSON.stringify(payload);
}

let addr = "";
try {
  addr = readFileSync(join(fixtureDir, "addr.txt"), "utf8").trim();
} catch (e) {
  reply({ ok: false, error: `cannot read addr.txt under TRIAL_FIXTURE_DIR: ${String(e).slice(0, 120)}` });
}
const [host = "127.0.0.1", port = "0"] = addr.split(":");
const socket = connect({ host, port: Number(port) });
let buf = "";
const finish = (payload: string) => {
  console.log(payload.trim());
  socket.destroy();
  process.exit(0);
};
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${request.replace(/\s+/g, " ")}\n`));
socket.on("data", (chunk) => {
  buf += chunk;
  const idx = buf.indexOf("\n");
  if (idx >= 0) finish(buf.slice(0, idx));
});
socket.on("error", (e) => {
  reply({ ok: false, error: `fixture socket error: ${e.message}` });
});
setTimeout(() => reply(buf.trim() || JSON.stringify({ ok: false, error: "timeout waiting for fixture" })), 10_000);
