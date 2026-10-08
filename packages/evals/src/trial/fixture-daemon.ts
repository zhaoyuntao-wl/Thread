// 夹具守护进程：持有 W/R 与事务状态，供 agent 经 client 逐条驱动（spec D4）。
// 环境变量：TRIAL_FIXTURE_SCHEDULE=active-writer|stale-snapshot，TRIAL_FIXTURE_DIR=<临时目录>
// 就绪后把回环地址写进 <DIR>/addr.txt，并打印 READY 行；命令与响应均为单行 JSON。
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TrialFixture, type CommandRequest, type Schedule } from "./fixture.js";

const schedule = (process.env.TRIAL_FIXTURE_SCHEDULE ?? "active-writer") as Schedule;
const dir = process.env.TRIAL_FIXTURE_DIR;
if (!dir) throw new Error("TRIAL_FIXTURE_DIR is required");

const fixture = new TrialFixture({ schedule, dir });
fixture.setup();
const validity = fixture.validity();
writeFileSync(join(dir, "validity.json"), `${JSON.stringify({ schedule, ...validity, handoff: fixture.finalState() }, null, 2)}\n`, "utf8");

const server = createServer((socket) => {
  let buf = "";
  socket.setEncoding("utf8");
  // 客户端（一次性 CLI）读完即断，必须接住 ECONNRESET——否则整条夹具守护进程会被未处理的
  // socket 'error' 事件带走（2026-10-07 实测：后续所有命令 ECONNREFUSED，trial 直接作废）。
  socket.on("error", (e) => {
    console.error(`fixture socket error: ${e.message}`);
  });
  socket.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        let payload: unknown;
        try {
          const req = JSON.parse(line) as CommandRequest;
          payload = req.cmd === "timeline" ? { ok: true, ledger: fixture.ledger, final: fixture.finalState() } : fixture.handle(req);
        } catch (e) {
          payload = { ok: false, error: String(e).slice(0, 200) };
        }
        // 每条命令后落一次终态：Windows 上 driver 只能强杀（kill() 不走优雅信号），
        // 靠 SIGTERM 写 final.json 会缺终态、把成功格误判成失败（2026-10-07 实测）。
        try {
          writeFileSync(join(dir, "state.json"), `${JSON.stringify({ schedule, final: fixture.finalState(), ledgerEntries: fixture.ledger.length }, null, 2)}\n`, "utf8");
        } catch {
          /* 落盘失败不阻塞命令 */
        }
        socket.write(`${JSON.stringify(payload)}\n`);
      }
      idx = buf.indexOf("\n");
    }
  });
});

server.on("error", (e) => {
  console.error(`fixture server error: ${e.message}`);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no tcp address");
  writeFileSync(join(dir, "addr.txt"), `127.0.0.1:${addr.port}\n`, "utf8");
  console.log(`READY ${schedule} 127.0.0.1:${addr.port} dir=${dir}`);
});

const shutdown = () => {
  try {
    writeFileSync(join(dir, "final.json"), `${JSON.stringify({ schedule, ledger: fixture.ledger, final: fixture.finalState() }, null, 2)}\n`, "utf8");
  } finally {
    fixture.close();
    server.close();
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
