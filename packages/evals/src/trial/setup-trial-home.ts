// 建立隔离 trial home（spec D7 / §4-3）：复制 headless profile → <home>/profiles/trial，
// 关掉 dsh-thread（避免双卡）、把 MCP 查询通道的 THREAD_ROOT 改为 env 驱动、插入测试注入缝。
// 一次建立，多轮复用（THREAD_ROOT / TRIAL_CARD_FILE / TRIAL_EVIDENCE_FILE 都走 env）。
// 用法：node dist/trial/setup-trial-home.js --home=<dir>
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const homeArg = process.argv.find((a) => a.startsWith('--home='));
const dshHome = homeArg?.split('=')[1];
if (!dshHome) throw new Error('--home=<dir> is required');

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// 查询通道指向**插件仓 dist**（不是 profile 副本）；默认取仓库的同级 checkout，可用 env 覆盖。
const mcpServer = (process.env.TRIAL_MCP_SERVER ?? join(REPO_ROOT, '..', 'dsh-plugin-thread', 'dist', 'server.js')).replace(/\\/g, '/');

const realHome = process.env.REAL_DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const srcProfile = join(realHome, 'profiles', 'headless');
if (!existsSync(srcProfile)) throw new Error(`headless profile not found: ${srcProfile}`);

const profileDir = join(dshHome, 'profiles', 'trial');
const seamDir = join(process.cwd(), 'src', 'trial', 'seam');
for (const file of ['index.mjs', 'package.json']) {
  if (!existsSync(join(seamDir, file))) throw new Error(`seam file missing: ${join(seamDir, file)}`);
}

if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
mkdirSync(join(dshHome, 'profiles'), { recursive: true });
cpSync(srcProfile, profileDir, { recursive: true });

// 注入缝以**正规包**形态安装（不是 profile 根目录的裸文件）：裸文件行（file URL）会让
// deepseek 请求扩展的插件清单贡献者在 prepare 阶段抛错（REQUEST_EXTENSION，2026-10-07 实测定位）。
const seamPkgName = 'dsh-thread-trial-seam';
const seamPkgDir = join(profileDir, 'node_modules', seamPkgName);
mkdirSync(seamPkgDir, { recursive: true });
copyFileSync(join(seamDir, 'index.mjs'), join(seamPkgDir, 'index.mjs'));
copyFileSync(join(seamDir, 'package.json'), join(seamPkgDir, 'package.json'));
const seamDst = join(seamPkgDir, 'index.mjs');

const profilePkgPath = join(profileDir, 'package.json');
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8')) as {
  dependencies?: Record<string, string>;
};
profilePkg.dependencies = { ...(profilePkg.dependencies ?? {}), [seamPkgName]: 'file:./node_modules/dsh-thread-trial-seam' };
writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8');

const credentials = join(realHome, '.credentials.yaml');
if (existsSync(credentials)) copyFileSync(credentials, join(dshHome, '.credentials.yaml'));
// 与真实 home 同源的其余状态（凭证/会话设置/匿名 id）：缺失时 dsh 在 REQUEST_EXTENSION 阶段直接失败
for (const item of ['.credentials.yaml', 'settings.yaml.imported', '.anonymous-user-id']) {
  const src = join(realHome, item);
  if (existsSync(src)) copyFileSync(src, join(dshHome, item));
}
for (const dir of ['storages', 'llm-deepseek']) {
  const src = join(realHome, dir);
  if (existsSync(src)) cpSync(src, join(dshHome, dir), { recursive: true });
}

const override = `
# ── trial overlay（行为验收 rig；由 setup-trial-home 生成，勿手改）────────────────
# 查源通道保持真实可用：THREAD_ROOT 由 env 注入临时根（绝不写生产 ~/.thread）
- id: mcp-thread
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: thread
    transport: stdio
    command: node
    args: ['${mcpServer}']
    env:
      THREAD_ROOT: !!js process.env.THREAD_ROOT
    failOnStartupError: true
# 双卡守卫：产品卡注入关掉，改由测试缝注入冻结文本
- id: dsh-thread
  disabled: true
- insert:
    - id: trial-seam
      name: 'dsh-thread-trial-seam'
`;

const patchPath = join(profileDir, 'cordis.patch.yml');
const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
writeFileSync(patchPath, `${existing.replace(/\n*$/, '\n')}${override}`, 'utf8');

console.log(`trial home: ${dshHome}`);
console.log(`profile:    ${profileDir}`);
console.log(`seam:       ${seamDst}`);
console.log(`patch:      ${patchPath}`);
