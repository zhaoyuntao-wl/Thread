#!/usr/bin/env node
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginService } from "./auth.js";
import { FileSecurityStateStore, FileUserStore } from "./store.js";

const USERNAME = "alice";
const PASSWORD = "pw-123456";

interface CliArgs {
  root: string;
  secret: string;
  changePassword: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: join(tmpdir(), "thread-login-demo"),
    secret: "dev-secret-change-me",
    changePassword: false,
    reset: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--root":
        args.root = argv[++i] ?? args.root;
        break;
      case "--secret":
        args.secret = argv[++i] ?? args.secret;
        break;
      case "--change-password":
        args.changePassword = true;
        break;
      case "--reset":
        args.reset = true;
        break;
      case "--help":
        console.log(`用法: npx tsx examples/login/cli.ts [选项]

端到端登录演示：注册 → 登录 → 鉴权 → 重启持久化验证 → 登出。
用户持久化在 <root>/users.json，默认 root 为系统临时目录下 thread-login-demo。

选项:
  --root <dir>          用户数据目录（跨运行持久化）
  --secret <secret>     JWT 签名密钥（生产环境必须替换）
  --change-password     额外演示改密流程（用一次性用户，可重复运行）
  --reset               先清空用户数据再演示`);
        process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const usersFile = join(args.root, "users.json");
  const stateFile = join(args.root, "security.json");
  if (args.reset) {
    rmSync(usersFile, { force: true });
    rmSync(stateFile, { force: true });
  }

  const service = new LoginService(args.secret, {
    store: new FileUserStore(usersFile),
    stateStore: new FileSecurityStateStore(stateFile),
  });
  const step = (title: string): void => console.log(`\n== ${title}`);
  const say = (msg: string): void => console.log(`   ${msg}`);

  step(`注册 ${USERNAME}（数据文件：${usersFile}）`);
  const registered = service.register(USERNAME, PASSWORD);
  if ("error" in registered) {
    say("alice 已存在——这是上次运行持久化的用户，直接复用");
  } else {
    say(`注册成功 id=${registered.id} createdAt=${registered.createdAt}`);
  }

  step("登录");
  const login = service.login(USERNAME, PASSWORD);
  if (!login.ok) {
    say(`登录失败：${login.reason}`);
    process.exit(1);
  }
  const token = login.token;
  say(`登录成功，token=${token.slice(0, 24)}…`);

  step("鉴权");
  const payload = service.authenticate(token);
  say(
    payload
      ? `token 有效：sub=${payload.sub} username=${payload.username} exp=${new Date(payload.exp).toISOString()}`
      : "token 无效（异常）",
  );

  step("重启持久化验证（同一数据文件新建服务实例）");
  const restarted = new LoginService(args.secret, {
    store: new FileUserStore(usersFile),
    stateStore: new FileSecurityStateStore(stateFile),
  });
  const again = restarted.authenticate(token);
  say(again ? "新实例仍能鉴权同一 token：用户与密钥已落盘" : "新实例鉴权失败（异常）");

  step("登出");
  service.logout(token);
  say(service.authenticate(token) ? "登出后 token 仍有效（异常）" : "登出后 token 已吊销");

  step("重启后吊销持久化验证（新实例仍拒收已吊销 token）");
  const restartedAfterLogout = new LoginService(args.secret, {
    store: new FileUserStore(usersFile),
    stateStore: new FileSecurityStateStore(stateFile),
  });
  say(
    restartedAfterLogout.authenticate(token)
      ? "新实例仍接受已吊销 token（异常）"
      : "新实例拒收已吊销 token：吊销状态已落盘",
  );

  if (args.changePassword) {
    step("改密演示（一次性用户）");
    const demoUser = `demo-${Date.now().toString(36)}`;
    const r1 = service.register(demoUser, "old-password-1");
    if ("error" in r1) {
      say(`注册演示用户失败：${r1.error}`);
      return;
    }
    const changed = service.changePassword(demoUser, "old-password-1", "new-password-2");
    say(`改密结果：${changed.ok ? "成功" : `失败（${changed.reason}）`}`);
    const oldLogin = service.login(demoUser, "old-password-1");
    say(oldLogin.ok ? "旧密码登录成功（异常）" : `旧密码登录被拒：${oldLogin.reason}`);
    const newLogin = service.login(demoUser, "new-password-2");
    say(newLogin.ok ? "新密码登录成功" : `新密码登录被拒：${newLogin.reason}`);
  }

  console.log("\n完成。再次运行本命令可看到 alice 直接来自持久化数据。");
}

main();
