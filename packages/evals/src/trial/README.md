# 行为验收 rig（trial）

回答一个确定性回归集答不了的问题：**卡里丢了句尾适用条件时，接收方会不会沿着锚回查原文、再据此行动。**

装置 = 夹具（可复现的 SQLite 状态机）+ 冻结卡（离线渲染后回放）+ 测试专用注入缝 + 驱动 + 评分。设计依据与逐条决策见本地 `docs/local/behavior-trial-spec-2026-10-07.md`（D1–D10、§8 实施记录、§9 stage 1 结果）。

## 怎么跑

```sh
# 1) 冻结三臂卡（旧卡 1.0.11 / 旧卡无锚 / 新卡 1.0.12），带判据断言
node dist/trial/freeze-card.js --out=<repo>/.trial/cards/new-session

# 2) 建隔离 trial home（复制 headless profile + 凭证/设置，关掉产品卡注入、挂注入缝）
node dist/trial/setup-trial-home.js --home=<repo>/.trial/home

# 3) 跑（单格 / 整批）
node dist/trial/run-trial.js --stage=stage1 --schedule=active-writer --arm=new --index=1
node dist/trial/run-trial.js --batch=stage1 --k=5 --task=strict

# 4) 评分（recovery / source-lookup 分开）与逐格记录
node dist/trial/score-trial.js --stage=stage1
node dist/trial/report-trial.js --stage=stage1

# 夹具自测（确定性，随包 vitest 跑）
npx vitest run src/trial/fixture.test.ts
```

## 环境变量（默认值均为仓库相对，不写死本机路径）

| 变量 | 作用 | 默认 |
|---|---|---|
| `TRIAL_DSH_HOME` | 隔离 trial home（profile 名固定 `trial`） | `<repo>/.trial/home` |
| `TRIAL_CARDS_DIR` | 冻结卡目录 | `<repo>/.trial/cards/new-session` |
| `TRIAL_OUT_ROOT` | 运行产物根 | `<repo>/.trial/runs` |
| `TRIAL_MCP_SERVER` | 查询通道指向的插件仓 MCP server | `<repo>/../dsh-plugin-thread/dist/server.js` |
| `TRIAL_DSH_VERSION` / `TRIAL_PLUGIN_VERSION` | 写进每格版本锚 | `unknown` |
| `REAL_DSH_HOME` | 复制凭证/设置的来源 | `%USERPROFILE%/.dsh` |

前置：本机装好 dsh CLI、目标 profile 的凭证可用、插件仓已 build（MCP server 存在）。跑不进 CI（需要 live 模型与本地 profile），`packages/evals` 亦为私有包。

## 这套装置能证明什么、不能证明什么

**能**：在给定夹具与固定 harness 下，逐格判定 (a) 恢复动作顺序与终态是否达标（recovery，从夹具命令账本取），(b) 接收方是否在首个改状态命令**之前**回查记忆并拿到完整决策（source-lookup，从会话事件取）。判据不看模型自己的解释、也不看 stdout。

**不能**：

- **不能**给出成功率——每格 k 次只是观测计数，不做显著性宣称；
- **不能**用"通过"证明记忆起了作用——通过方向不可信、失败方向才有信息量；`recovery 30/30` 的 stage 1 结果正说明**本夹具在任务结果层面区分不出渲染器修复**（两条 schedule 都在模型基线能力内）；
- **不能**把查源率当成"沿锚跟进"的纯测量：无锚臂里决策仍可按关键词搜到，而任何点名了决策的卡片本身就会招来一次核对；
- **不能**外推到别的任务、别的模型或别的卡片档位（stage 1 只跑 `new-session` 档）。

## 已知坑（细节见规格 §8）

1. 注入缝必须是**正规包**放进 profile `node_modules`；裸文件行（`file://`）会让请求扩展抛 `REQUEST_EXTENSION`。
2. trial 工作区跑 dsh 必须 `DSH_PERMISSION_MODE=danger-full-access`，否则 Windows 授写失败、整轮命令都执行不了。
3. 夹具守护进程必须接住 socket `ECONNRESET`（一次性 CLI 客户端读完即断，否则守护进程被带走）。
4. 终态写 `state.json`（每条命令后），不依赖 SIGTERM 的 `final.json`（Windows 上只能强杀）。
5. 播种的项目键必须等于 trial 会话工作区，否则查源通道落到空桶、lookup 指标被夹具错误污染。
6. 判据不得要求 agent 自己撞出 517：517 由夹具在交接前制造，直接回滚才是正确行为。
