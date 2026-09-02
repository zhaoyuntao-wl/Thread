// AML 形态自测探针（2026-09-02）：裸 core（事件流 + BM25）在"AML 只喂文本"赛制下的真实检索水平。
// 方法：把 11 个 eval 场景的全部 turn 文本按 adapter Add 形态（user_message 事件）灌入干净 store——
// 不用 applyTurn（那是 Thread 结构化管线），不建决策/目标行——模拟"Add 只收文本、Search 只靠 BM25"。
// 探针三类：① 原式查询（eval 已有 recall 期望）② 语义改写（同义换词，测语义近义断点）③ 最新态（治理/时序维）。
import { queryMemory, ThreadStore } from "@thread-memory/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./scenarios.js";

interface Probe {
  scenario: string;
  kind: "exact" | "paraphrase" | "latest";
  query: string;
  mustContain: string;
  note?: string;
}

const PROBES: Probe[] = [
  { scenario: "decision-chain", kind: "exact", query: "bcrypt 加密", mustContain: "bcrypt", note: "eval 原式" },
  { scenario: "repeat-question", kind: "exact", query: "better-sqlite3", mustContain: "better-sqlite3", note: "eval 原式" },
  { scenario: "repeat-question", kind: "exact", query: "事件存储", mustContain: "事件存储", note: "eval 原式" },
  { scenario: "file-lineage", kind: "exact", query: "auth 重构", mustContain: "重构", note: "eval 原式" },
  { scenario: "compact-fidelity", kind: "exact", query: "bcrypt 加密", mustContain: "bcrypt", note: "eval 原式" },
  { scenario: "decision-chain", kind: "paraphrase", query: "密码怎么加密的", mustContain: "bcrypt", note: "同义换词：加密→怎么加密" },
  { scenario: "repeat-question", kind: "paraphrase", query: "数据库用的哪个库", mustContain: "better-sqlite3", note: "同义换词：SQLite/库→数据库" },
  { scenario: "file-lineage", kind: "paraphrase", query: "登录逻辑改过什么", mustContain: "重构", note: "同义换词：重构→改过" },
  { scenario: "injection-follow", kind: "paraphrase", query: "接口代理用什么实现", mustContain: "Kong", note: "同义换词：网关→接口代理" },
  { scenario: "decision-chain", kind: "latest", query: "认证方案", mustContain: "Session", note: "最新态：JWT 已被 Session 取代，应能定位最新方案" },
  { scenario: "compact-fidelity", kind: "latest", query: "认证 方案", mustContain: "Session", note: "最新态：压缩摘要后改用 Session，最新决策应可召回" },
];

function appendTurnText(store: ThreadStore, scenarioId: string, turns: typeof SCENARIOS[number]["turns"]): void {
  let t = 0;
  const nextTs = () => new Date(new Date("2026-08-13T00:00:00.000Z").getTime() + t++ * 1000).toISOString();
  for (const turn of turns) {
    const parts: string[] = [];
    if (turn.user) parts.push(turn.user);
    if (turn.assistant) parts.push(turn.assistant);
    if (turn.decision) parts.push(`决策：${turn.decision.text}`);
    if (turn.feedback) parts.push(turn.feedback.text);
    if (turn.tool) {
      parts.push(`${turn.tool.name} ${JSON.stringify(turn.tool.input).slice(0, 200)}`);
      if (turn.tool.output) parts.push(turn.tool.output);
    }
    if (turn.compact) parts.push(turn.compact);
    for (const part of parts) {
      store.append({ session_id: `aml-${scenarioId}`, kind: "user_message", ts: nextTs(), body: part });
    }
  }
}

// ② 噪声模拟（AML 抗噪维）：每场景灌 200 条无关工程闲聊事件，量 top-5 精度与首个相关命中排名
const NOISE_TEMPLATES = [
  "任务 F{n}：重构缓存模块，采用 LRU 淘汰策略",
  "任务 F{n}：修复分页组件在大数据集下的渲染卡顿",
  "任务 F{n}：给 CLI 增加 dry-run 模式并补齐单测",
  "任务 F{n}：迁移旧版 API 到 v2，保持向后兼容",
  "任务 F{n}：压测并发写入时发现锁竞争问题",
  "任务 F{n}：优化启动时间，移除冷启动里的同步 IO",
  "任务 F{n}：排查内存泄漏，定位到事件监听未解绑",
  "任务 F{n}：增加灰度开关，按租户比例放量",
  "任务 F{n}：补文档并同步到内部知识库",
  "任务 F{n}：把日志采样率调到千分之一以控成本",
];

function appendNoise(store: ThreadStore, scenarioId: string, count: number): void {
  const base = new Date("2026-08-13T00:00:00.000Z").getTime();
  for (let i = 1; i <= count; i++) {
    const body = NOISE_TEMPLATES[i % NOISE_TEMPLATES.length].replace("{n}", String(i));
    store.append({
      session_id: `aml-${scenarioId}`,
      kind: "user_message",
      ts: new Date(base + i * 2000).toISOString(),
      body,
    });
  }
}

// ③ 同主题干扰噪声：与场景共享关键词但内容无关（AML 抗噪的真实形态——同仓库相似 issue）
const TOPIC_NOISE: Record<string, string[]> = {
  "decision-chain": [
    "任务 F{n}：把 JWT 校验迁移到网关层，减少业务侧重复代码",
    "任务 F{n}：登录页加验证码，防止暴力破解",
    "任务 F{n}：Session 过期时间从 30 分钟调到 2 小时",
    "任务 F{n}：密码找回流程接入短信服务",
  ],
  "repeat-question": [
    "任务 F{n}：数据库连接池从 5 调到 20，压测吞吐",
    "任务 F{n}：SQLite 迁移到 Postgres 的可行性评估",
    "任务 F{n}：存储层加读写分离，主从延迟监控",
  ],
  "file-lineage": [
    "任务 F{n}：重构 auth 中间件，把鉴权逻辑抽出",
    "任务 F{n}：登录接口加限流，防刷",
    "任务 F{n}：auth 模块补集成测试，覆盖多设备登录",
  ],
  "compact-fidelity": [
    "任务 F{n}：JWT 密钥轮换脚本，按季度执行",
    "任务 F{n}：注册接口加邮箱验证，防止垃圾账号",
    "任务 F{n}：Session 存储从内存迁移到 Redis",
  ],
  "injection-follow": [
    "任务 F{n}：网关层加熔断，下游超时自动降级",
    "任务 F{n}：Kong 插件开发，做请求签名校验",
    "任务 F{n}：API 网关日志加 traceId 透传",
  ],
};

function appendTopicNoise(store: ThreadStore, scenarioId: string, count: number): void {
  const templates = TOPIC_NOISE[scenarioId];
  if (!templates) {
    return;
  }
  const base = new Date("2026-08-13T00:00:00.000Z").getTime();
  for (let i = 1; i <= count; i++) {
    store.append({
      session_id: `aml-${scenarioId}`,
      kind: "user_message",
      ts: new Date(base + 1_000_000 + i * 2000).toISOString(),
      body: templates[i % templates.length].replace("{n}", String(i)),
    });
  }
}

function main(): void {
  const lines: string[] = [];
  let hitCount = 0;
  let total = 0;
  const missByKind: Record<string, string[]> = { exact: [], paraphrase: [], latest: [] };

  for (const scenario of SCENARIOS) {
    const dir = mkdtempSync(join(tmpdir(), "thread-aml-probe-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "aml-probe",
    });
    try {
      appendTurnText(store, scenario.id, scenario.turns);
      appendNoise(store, scenario.id, 200);
      appendTopicNoise(store, scenario.id, 100);
      for (const probe of PROBES.filter((p) => p.scenario === scenario.id)) {
        total++;
        const bare = queryMemory(store, probe.query, { sessionId: `aml-${scenario.id}`, tokenBudget: 2000, limit: 5 });
        const org = queryMemory(store, probe.query, {
          sessionId: `aml-${scenario.id}`,
          tokenBudget: 2000,
          limit: 5,
          organize: true,
          projectKey: "aml-probe",
        });
        const summarize = (r: { results: Array<{ body: string; latest?: boolean; structured?: string }> }) => {
          const first = r.results.findIndex((x) => x.body.includes(probe.mustContain));
          const relevant = r.results.filter((x) => x.body.includes(probe.mustContain)).length;
          return { first: first >= 0 ? first + 1 : 0, relevant };
        };
        const b = summarize(bare);
        const o = summarize(org);
        const hit = o.first > 0;
        const status = hit ? "HIT" : "MISS";
        if (hit) hitCount++;
        else missByKind[probe.kind].push(`${probe.scenario}「${probe.query}」`);
        const orgTop = org.results
          .slice(0, 3)
          .map((r) => `#${r.segment_id}${r.structured ? `[${r.structured}]` : ""}${r.latest ? "(最新)" : ""} ${r.body.slice(0, 34)}`)
          .join(" | ");
        const line = `[${status}] [${probe.kind}] ${probe.scenario}「${probe.query}」裸:首个@${b.first || "无"}·相关${b.relevant}/5 → 组织:首个@${o.first || "无"}·相关${o.relevant}/5 | ${orgTop || "空"}`;
        lines.push(line);
        console.log(line);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const summary = [
    "",
    `=== 汇总：${hitCount}/${total} 命中 ===`,
    ...Object.entries(missByKind)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `MISS[${k}] ${v.length} 条: ${v.join("；")}`),
  ];
  lines.push(...summary);
  summary.forEach((l) => console.log(l));

  const outPath = join(process.cwd(), "docs", "local", "spike", "aml-self-test-2026-09-02.md");
  mkdirSync(join(process.cwd(), "docs", "local", "spike"), { recursive: true });
  writeFileSync(
    outPath,
    `# AML 形态自测（2026-09-02）：裸 core 检索水平\n\n方法：11 场景文本按 adapter Add 形态灌入干净 store（无结构化表/无 applyAnalysis），BM25 三类探针。\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
    "utf8",
  );
  console.log(`report -> ${outPath}`);
}

main();
