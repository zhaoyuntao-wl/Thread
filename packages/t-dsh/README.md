# t-dsh

Thread 一键旗舰 profile——`dsh --profile thread` 启用完整会话记忆（确定性采集 + 状态卡注入 + MCP 查询）。

## 安装（一条命令）

```sh
npm install -g t-dsh && t-dsh
```

生成 `~/.dsh/profiles/thread/`，然后：

```sh
npm install -g thread-mcp     # MCP 查询通道
dsh plugin add dsh-thread     # 采集 + 注入插件
dsh --profile thread "任务"    # 启动带会话记忆的会话
```

或手动创建 profile：把 `dsh.profile.bundles`（dsh-base + dsh-headless + dsh-thread）写入 `~/.dsh/profiles/thread/package.json`。

## 说明

- 事件写 `~/.thread/projects/<项目键>/events.db`（按项目隔离），结构化写 `~/.thread/structured.db`，项目目录零污染
- 查询：会话内 MCP 工具 `query_session_memory`（thread-mcp 提供）
- 版本：钉 dsh `0.1.0-rc.6`，compat 矩阵见 CI
