#!/usr/bin/env node
// t-dsh 一键安装：生成 ~/.dsh/profiles/thread/（bundles + MCP overlay），随后 dsh --profile thread 使用。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const profileDir = join(homedir(), ".dsh", "profiles", "thread");
mkdirSync(profileDir, { recursive: true });

const profilePkg = {
  name: "dsh-profile-thread",
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-thread"],
    },
  },
};

const patch = `# Thread: dsh-thread 插件由 bundle 层提供；此处持久化 MCP overlay（查询通道）。
- insert:
    - id: mcp-thread
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: thread
        transport: stdio
        command: npx
        args: ['thread-mcp']
        failOnStartupError: true
`;

writeFileSync(join(profileDir, "package.json"), JSON.stringify(profilePkg, null, 2) + "\n");
writeFileSync(join(profileDir, "cordis.patch.yml"), patch);

console.log(`已生成 profile: ${profileDir}`);
console.log("下一步（三件套一条命令装完）：");
console.log("  npm install -g thread-mcp        # MCP 查询通道");
console.log("  dsh plugin add dsh-thread        # 采集 + 注入插件");
console.log("  dsh --profile thread \"任务\"       # 启动带会话记忆的会话");
