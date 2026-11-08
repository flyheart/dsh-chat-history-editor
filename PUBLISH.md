# 发布 Chat History Editor 插件

这份文档面向维护者，说明如何把这个 bundle 发布出去，让别人通过 DSH 的 Plugin Manager / Discover 安装。
插件是标准的 Cordis bundle：Host 半（`index.js` + `history-ops.js`）在 DSH 进程内运行，Client 半（`client.js`）是 Web 页面的模块，二者靠 `package.json` 的 `dsh` 字段声明。

## 0. 发布前检查

```bash
cd chat-history-editor
npm test                 # 43 项离线检查（host / command / client）
                         # 没有本地 DSH 安装时 Host 两项会 SKIP（可设 DSH_INSTALL_ROOT 指向 @deepseek-ai/dsh 运行）
npm pack --dry-run       # 查看真正会发布的文件
```

打包清单应包含：`package.json`、`index.js`、`history-ops.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`。
`test/`、`tools/`、`PUBLISH.md` 不随包发布（由 `files` 控制）。

Manifest 必须满足的约定（已就绪，除名称/private 外不用改）：

| 字段 | 要求 |
|---|---|
| `dsh.bundle.patch` | 指向 `cordis.patch.yml`，bundle 才能被 Plugin Manager 识别 |
| `dsh.client.platform` | `"web"`，Client 半只在 Web 组合中加载 |
| `dsh.client.inject` | Web 组合里的模块名（仅排激活顺序；缺失的名字会被跳过） |
| `exports["."]` / `exports["./client"]` | Host / Client 入口，缺 Client 入口会拒绝加载 |
| `exports["./locale/*.json"]`、`exports["./icon"]` | Plugin Manager / Discover 的标题、描述、图标 |
| Client 模块 id | **必须等于包名**（`client.js` 里 `window.__ModuleLoader__.load({ id })`） |
| `engines.dsh` | DSH 版本兼容范围，安装前检查；当前为 `>=0.2.1-rc.2 <0.3.0-0`（覆盖 DSH Desktop 的 `0.2.2-alpha.2`） |
| `private` | 发布前必须删除 |

命名：`@local/...` 只是本地占位，npm 上不能用别人的 scope。用自带的改名工具一次性同步所有必须一致的位置：

```bash
node tools/rename.mjs dsh-chat-history-editor
# 同步更新：package.json name、cordis.patch.yml 的行 name、client.js 的模块/CSS id、client 测试里的期望 id
```

（可选）补全 npm 元数据：

```bash
npm pkg set author="Your Name"
npm pkg set repository.url="https://github.com/flyheart/dsh-chat-history-editor"
npm pkg set homepage="https://github.com/flyheart/dsh-chat-history-editor"
```

## 1. 发布到 npm

```bash
npm login
npm publish            # 未 scoped 包；如果改为 @scope/name，则用 npm publish --access public
```

推送到 GitHub 并打 tag 时，`.github/workflows/publish.yml` 通过 **GitHub OIDC trusted publishing** 自动发布（不需要 `NPM_TOKEN`），并自动生成 provenance：

```bash
git push -u origin main
git tag v1.0.0 && git push origin v1.0.0
# 或：GitHub → Actions → publish → Run workflow
```

首次发布的 tag 若因代码问题失败（此时 npm 上还没有该版本），修好后把 tag 移到新提交即可重新触发，无需改版本号：

```bash
git tag -f v1.0.0 && git push -f origin v1.0.0
```

### 配置 Trusted Publisher（一次性，npm 侧）

workflow 已经改成 OIDC：没有 `NODE_AUTH_TOKEN`，发布时 npm 用 GitHub Actions 的 OIDC 令牌向 registry 换取发布凭据，并自动生成 provenance。只需要在 **npm 侧**建立一次“包 ↔ GitHub Actions”的信任关系。

前置条件：

- 包已存在于 npm（`dsh-chat-history-editor` 已发布）；
- npm 账号已启用 **2FA**（trust 命令强制要求）；
- 本机 npm **≥ 11.15.0**（`npm trust` 命令需要）；
- 不能用“Bypass 2FA”的 Granular Token 执行 trust 命令（会拒绝），必须用交互登录。

**方式 A：`npm trust` 命令行（推荐）**

```bash
npm install -g npm@^11.15.0
npm logout                     # 见下方“常见错误”：先清掉本机可能存在的 bypass-2FA token
npm login --auth-type=web      # 浏览器登录 + 2FA
npm whoami                     # 确认身份（如 jake001）
npm trust github dsh-chat-history-editor \
  --file publish.yml \
  --repo flyheart/dsh-chat-history-editor \
  --allow-publish \
  --yes
npm trust list dsh-chat-history-editor   # 确认配置存在
```

`--allow-publish` 是必填的权限标记（npm 11.15+ 要求至少一个）：它允许该 trusted publisher 执行 `npm publish`。如果以后改用 `npm stage publish`，再加 `--allow-stage-publish`（两个可以同时给）。

**常见错误**

- `At least one permission flag is required (--allow-publish, --allow-stage-publish)`：漏了权限标记，按上面命令加上。
- `403 Forbidden - GET https://registry.npmjs.org/-/package/<pkg>/trust`：本机 `~/.npmrc` 里的 `_authToken` 是 **Bypass 2FA 的 Granular Token**（例如给 CI 用的那个），trust 接口明确拒绝这类 token。先 `npm logout`，再用 `npm login --auth-type=web` 做一次网页登录（或改用 npm 网页配置），不要用 `NODE_AUTH_TOKEN` / bypass token 执行 trust 命令。

- `--file` 是**仓库内**的 workflow 文件名，必须与实际文件一致：`publish.yml`；
- 未配置 environment 时不要传 `--env`；
- 每个包只允许一条 trust 配置；要换配置先 `npm trust revoke --id <id> dsh-chat-history-editor`。

**方式 B：npm 网页**

1. 打开包设置：<https://www.npmjs.com/package/dsh-chat-history-editor/settings>
2. **Trusted Publisher** → **GitHub Actions**：
   - Organization or user：`flyheart`
   - Repository：`dsh-chat-history-editor`
   - Workflow filename：`publish.yml`
   - Environment name：留空
3. 保存（会要求 2FA）。

配置完成后：

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 删除 `NPM_TOKEN`（CI 已不再使用）。
2. 到 npm 的 Access Tokens 页面 **Revoke** 之前用于发布的 token。
3. 下一个版本验证 OIDC 发布：

```bash
npm version patch                 # 例如 1.0.2
git push origin main
git tag v1.0.2 && git push origin v1.0.2
```

Actions 日志里应看到 `Publish through OIDC trusted publishing` 步骤成功（无 token），发布后：

```bash
npm view dsh-chat-history-editor@1.0.2 dist.attestations --json   # 应有 provenance
```

Trusted publishing 文档：<https://docs.npmjs.com/trusted-publishers>；`npm trust` 命令文档：<https://docs.npmjs.com/cli/v11/commands/npm-trust>。

`prepublishOnly` 会再跑一遍测试。发布后确认：

```bash
npm view dsh-chat-history-editor version
npm view dsh-chat-history-editor dist.tarball
```

公开插件建议保持当前的 OIDC trusted publishing：发布自动附带可验证的构建来源（provenance），无需保存长期 token。

## 2. 安装与验证

官方推荐的安装入口是 Plugin Manager，它会同时完成“装依赖 + 选中 bundle + 尝试激活”：

```text
plugin_manager install_bundle { "target": "dsh-chat-history-editor" }
plugin_manager install_bundle { "target": "dsh-chat-history-editor@1.0.0" }
```

其他可用 target（同一个入口）：

| target | 用途 |
|---|---|
| `@scope/name` / `@scope/name@1.2.3` | 从 registry 安装（`inspect` 可先看版本/兼容性） |
| `/abs/path/to/chat-history-editor` | 本地目录（`link:`，开发时使用，改代码 + 重载插件生效） |
| `/abs/path/to/pkg.tgz` | `npm pack` 产物，适合灰度/离线分发 |
| `git+https://github.com/you/repo.git#<commit>` | Git 分发（建议固定 commit） |

> `dsh plugin --profile <name> add <spec>` 只是转发给 pnpm 装依赖，**不会选中 bundle**；选中/启用要通过 Plugins 页面或 `plugin_manager`。

干净的验证方式（不污染日常 profile）：

```bash
dsh --profile plugin-test --from-default-profile web --port 0 --no-open
# 打开打印出来的 URL → 侧边栏 Plugins → 安装上面的 target → 打开任意会话 → 顶部切换到“历史”页签
```

在已有 profile 上验证：安装后刷新页面（新增 Client 模块需要重新加载页面），确认：

- Plugins 页面能看到插件卡片：标题、描述、图标（`locale/en.json`、`locale/zh.json`、`icon.svg`）。
- 会话视图环出现「历史」页签，Chat / 轨迹 / 历史三个页签正常。
- 发布前在插件里自测过：即时编辑、删除、末尾新增、分支改写（开关 + 应用改写）。

### DSH Desktop（0.13.x）

DSH Desktop 用的仍是同一个 `web` profile（`DSH_HOME` 为
`~/Library/Application Support/dsh-desktop/harness`），页面还是同一套 Web 客户端，
所以 Client 半（`dsh.client.platform: "web"`）和 Host 半都原样加载，不需要单独的
desktop 构建；`engines.dsh` 的 `>=0.2.1-rc.2 <0.3.0-0` 已覆盖 Desktop 的内核
（`0.2.2-alpha.2`）。

首次启动时 Desktop 可能导入 CLI 的 `~/.dsh`。导入对第三方插件只复制
`package.json`（manifest-only stub），等后续 profile maintenance 重装；一旦
maintenance 因为其他导入 bundle 没有已安装 manifest 而 deferred，stub 就会留在
profile 里——下次启动 preflight 读不到 `cordis.patch.yml`，Desktop 进入 Safe Mode
并把插件禁用。修复用仓库自带的工具（幂等，默认只处理本插件和它的禁用标记）：

```bash
node tools/desktop-repair.mjs --dry-run   # 先看会改什么
node tools/desktop-repair.mjs             # 修复 Desktop 的 web profile
# 然后退出 Safe Mode / 重启 Desktop
```

该修复已在 DSH Desktop 0.13.2（Harness `0.2.2-alpha.2` + Desktop overlay）实测：
「历史」页签出现在 对话 / 轨迹 / 历史 视图环，台账渲染正常，编辑操作经
`/history` 命令写入 surface 后立即生效。

## 3. 升级与回滚

- 改代码后 `npm version patch|minor|major`，重新 `npm publish`。
- 已装旧版本时，Plugin Manager 的 `install_bundle` 会返回 `already-installed`；用 Plugins 页面的 Update（内部是“先移除再安装”），或先 `remove_bundle` 再安装新 target。
- 没有 HMR 的 profile 安装/升级后需要重启；`web` profile 默认启用 HMR，安装后即时生效。
- 改动了 `engines.dsh`（例如需要更新的 DSH）时，旧运行时会被拒绝并给出 `incompatible-version`；管理员可按 Plugin Manager 的 `list_version_exemptions` / `set_version_exemption` 流程临时放行（有风险确认）。
- 注意 semver 预发布语义：DSH 的兼容性检查按 `includePrerelease` 计算，所以 `>=0.2.1-rc.2 <0.3.0-0` 同时覆盖 `0.2.1-rc.x`、`0.2.2-alpha.x`（DSH Desktop 当前内核）等 0.2.x 预发布；显式上界保证 DSH 0.3 的预发布不会被误接受。DSH 进入新 minor（如 0.3.0-rc.1）后，需要发新插件版本并把上界更新到相应范围（或由用户走兼容性豁免）。
- 插件在 profile 内生效，**所有会话**共享同一份安装；Host 代码以 DSH 进程身份运行（在 workspace 沙箱之外），审阅后再发布/安装。

## 4. 发布到自建插件市场（可选）

DSH 的 Discover 只读取用户配置的市场索引（本安装默认没有内置索引源）。索引是格式 1 的 JSON，可以用自带工具生成并校验：

```bash
# 先发布 npm 版本，拿到发布时间的 Unix 秒：npm view <pkg> time.<version>
node tools/market-index.mjs -o market/index.json \
  --author "Your Name" \
  --repository https://github.com/flyheart/dsh-chat-history-editor \
  --timestamp 1790000000 \
  --validate \
  --dsh-root "$(npm root -g)/@deepseek-ai/dsh"
```

把 `market/index.json` 放到任意 **https** 静态地址（市场读取不允许重定向；http 也可但建议 https），用户在 Discover/Settings 中添加该 URL 后即可搜索、查看兼容性并一键安装。每个版本都需要：npm 已发布、索引里加一条 `versions[]`（`source: {type:'npm'}`、`engines.dsh`、`publishTimestamp`），然后重新托管索引文件。

## 5. 私有分发

- 私有 npm registry（Verdaccio、GitHub Packages 等）：在 profile 的 Plugin Manager 配置 `registry` / `fallbackRegistries`，或 pnpm 的 registry 配置中指向私有源；`install_bundle` 支持 registry name。
- 团队内网：直接给 `.tgz` 或 Git 地址即可；不想公开代码时优先 `.tgz` + 私有源。
- 本地开发：保持当前 `link:` 安装，改完代码用 Plugin Manager 重载/重启即可。
