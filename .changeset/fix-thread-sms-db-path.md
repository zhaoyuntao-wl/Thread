---
"@thread/adapter-qoder-cli": patch
---

修复 thread-sms MCP server 的数据库路径解析：从 dist 目录到仓库根需要 5 层 dirname，原实现少了两层，启动时直接崩溃（Cannot open database because the directory does not exist）。
