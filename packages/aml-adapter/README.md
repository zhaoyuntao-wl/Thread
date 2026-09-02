# AML Add/Search 适配器（@thread/aml-adapter）

Agent Memory Leaderboard 参赛适配器：把 Thread 内核（事件流水 + BM25/jieba 检索）包装成 AML 要求的 Add/Search HTTP 服务。

- **Add** → 事件追加（写时建索引，幂等可带 `id`）
- **Search** → 只返回记忆证据原文（不生成答案，符合参赛基本要求 1）
- **隔离**：每 `user_id` 一个独立 SQLite 库（sha256 目录），存储层即隔离（符合参赛基本要求 2）
- **零 LLM**：Add/Search 全程确定性，不使用任何模型（"gpt-4o-mini"条款仅约束用模型的参赛系统，本适配器天然满足）

## 运行

```sh
pnpm --filter @thread/aml-adapter build
THREAD_ROOT=./aml-data PORT=8787 AML_SYSTEM_KEY=your-key node packages/aml-adapter/dist/server.js
```

- `THREAD_ROOT`：数据目录（生产部署必须持久卷）
- `AML_SYSTEM_KEY`：设置后要求 `Authorization: Bearer <key>`（AML 的 Memory System Key）；不设置 = 无鉴权（仅限本地自测）

## 接口

```sh
# 健康检查
curl http://localhost:8787/health

# Add：写入一条对话/事件/文档
curl -X POST http://localhost:8787/add \
  -H 'content-type: application/json' \
  -d '{"user_id":"u1","content":"登录模块决定使用 Session 认证","id":"evt-1"}'

# Search：只回证据
curl -X POST http://localhost:8787/search \
  -H 'content-type: application/json' \
  -d '{"user_id":"u1","query":"登录方案 决策","limit":20}'
```

## Docker

```sh
docker build -t thread-aml-adapter .
docker run -p 8787:8787 -e AML_SYSTEM_KEY=xxx -v aml-data:/app/aml-data thread-aml-adapter
```

## AML 参赛准备状态（2026-09-02）

- 报名渠道：https://agentmemoryleaderboard.ai/evaluation（第二期预计 2026-09-20 开放）
- 组别：学术方法榜 · 学术·API 路径（自行部署 + 公开仓库 + 固定版本 + 运行说明）
- 提交后接口须保持公网可达 ≥30 天；Full 评测受理后不得更换版本
- 待第二期开放后核对官方 Add/Search 字段级契约，本适配器按需对齐
