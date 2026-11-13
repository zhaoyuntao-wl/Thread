# handoff 价值实验（handoff-ab）

回答一个回归集答不了的问题：**把前序状态「推送」给接手方，相对「只放记忆、让它自己查」，到底多给了什么。**

三臂对照，同一份记忆、空工作区、独立临时根：

| 臂 | 记忆 | 交接 |
|---|---|---|
| `push` | 有（目标/决策/旧计划待办/产物指针） | 有，含生产者策展的「下一步」 |
| `memory` | 同上 | 无 |
| `none` | 空 | 无 |

每臂 k 次独立运行，接手方是一个只收到两句提问的 agent。评分不看模型解释，只看：

1. 回答是否召回已定技术方案（`BM25`）；
2. 是否采用**生产者策展的下一步**（`先跑回归再动检索层`）——记忆里只有旧计划，只有交接带得过来；
3. 是否会沿用旧计划（`重构检索层`）；
4. 从会话事件库数 `tool_call LIKE '%query_session_memory%'` 的次数；
5. 结构化库里 `handoffs.status ∈ {delivered, ack}` 的数量。

## 怎么跑

```sh
pnpm --filter @thread/evals build
node dist/handoff/run.js --k=5
# 产物：<repo>/.evals/runs/handoff-ab.{json,md}
```

前置：本机装好 dsh CLI、`headless` profile 的凭证可用。跑不进 CI（要 live 模型），`packages/evals` 为私有包。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `HANDOFF_OUT_ROOT` | 产物与临时根 | `<repo>/.evals/runs` |
| `HANDOFF_DSH_HOME` | 隔离 home（复制 profile 后改 `THREAD_ROOT`） | `<HANDOFF_OUT_ROOT>/home` |
| `HANDOFF_PROFILE` | 跑哪个 profile | `headless` |
| `REAL_DSH_HOME` | 复制 profile/凭证的来源 | `%USERPROFILE%/.dsh` |

## 这套装置能证明什么、不能证明什么

**能**：在给定种子状态与固定 runner 下，逐次判定接手方是否召回了前序决策、是否采用策展的下一步、为拿到状态花了多少次查询、交接是否真的投递成功。

**不能**：

- **不能**把「推送组召回 5/5」当成交接的独有功劳——`memory` 臂靠状态卡提示去查也能达标，召回是**记忆层**的价值；
- **不能**给出统计显著性——k=5 是观测计数，不是假设检验；
- **不能**外推到别的任务形态、别的模型底座（当前只测单一 prompt 与 deepseek）；
- **不能**替身真实编排器：这里是"冷启动的接手方"，没有前置消息、没有 task 上下文注入。

## 已知坑（都是实测踩出来的）

1. **工作区必须为空**——否则模型直接读项目文档，`none` 臂也能答对，实验失去意义；
2. **必须换 `DSH_HOME`**——profile 的 MCP overlay 里 `THREAD_ROOT` 是写死的生产路径，不复制并改写，查询通道会打到生产库；
3. 任务文本经 `dsh` 传参在 Windows 下受引号契约影响，runner 采用「整条命令串 + 引号」的方式调用；
4. 每次运行前清空临时根：`handoffs`、事件库、`meta` 水位都会影响结果。

## 状态（2026-11-13）

- 评分核心（`score.ts`）与报表已带单测，确定性可回归；
- **live 三臂运行仍有隔离问题未收口**：`none` 臂偶发命中种子字串（说明某次运行没落在隔离根上，疑似工作区位于 git 仓库内导致项目键塌到仓库桶，或复制 profile 的 `THREAD_ROOT` 未生效）。runner 已加隔离自检：`none` 臂命中即写 `handoff-ab.invalid.json` 并 `exit 2`，不出报表；
- 因此**当前对外文档里的实测数字来自一次性脚本（`.trial/ab-handoff.mjs`）的那次运行，不是本 harness 产出的**；在隔离问题收口前，不要引用本 harness 的数字。
