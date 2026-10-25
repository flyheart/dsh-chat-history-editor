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
| `engines.dsh` | DSH 版本兼容范围，安装前检查；当前为 `>=0.2.1-rc.2` |
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

推送到 GitHub 并打 tag 时，`.github/workflows/publish.yml` 会用 `NPM_TOKEN` secret 自动发布并附带 provenance：

```bash
git push -u origin main
git tag v1.0.0 && git push origin v1.0.0
# 或：GitHub → Actions → publish → Run workflow
```

首次发布的 tag 若因代码问题失败（此时 npm 上还没有该版本），修好后把 tag 移到新提交即可重新触发，无需改版本号：

```bash
git tag -f v1.0.0 && git push -f origin v1.0.0
```

### `NPM_TOKEN` 从哪里来（2026 年后的 npm 规则）

npm 已停止创建 Classic Token（2025-11 起），CI 发布必须用 **Granular Access Token**：

1. 用**要拥有这个包的 npm 账号**登录 <https://www.npmjs.com>。
2. 头像 → **Access Tokens**（<https://www.npmjs.com/settings/~/tokens>）→ **Generate New Token** → **Granular Access Token**。
3. 配置：
   - Name：如 `github-actions-publish`；
   - Expiration：建议 90 天以内（write 权限 token 有最长有效期限制），到期前轮换；
   - Permissions：**Read and write**（不要选 "stage only"，那是 `npm stage publish` 用的）；
   - **Bypass 2FA：勾选**（GitHub Actions 是非交互环境，不勾会报 `EOTP`）；
   - Packages and scopes：**All packages**（最省事），或只选 `dsh-chat-history-editor`；
   - Organizations：无。
4. **Generate token**，复制只显示一次的 `npm_...`。
5. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**：
   Name 填 `NPM_TOKEN`，Value 粘贴 token（workflow 已写 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`）。

注意：

- 勾了 Bypass 2FA 的 token 仍能直接 `npm publish`，但 npm 计划 **2027-01 起移除 bypass-2FA token 的直接发布能力**，长期应改用 **Trusted Publishing（OIDC）**：先在 npmjs 包页面 Settings → Trusted Publisher 里填 GitHub Actions（owner `flyheart`、repo `dsh-chat-history-editor`、workflow 文件名 `publish.yml`），之后把 workflow 里的 `NODE_AUTH_TOKEN` 那行删掉即可（`id-token: write` 和 `--provenance` 已经配好）。一般先成功发布过一次（包页面存在）再配置。
- 只想手动发布、不配 Actions 时完全不需要 token：本机 `npm login`（浏览器登录 + 2FA）后 `npm publish` 即可。
- token 只放 GitHub Secret，不要提交进仓库；泄漏立即在 npm 页面 Revoke。

`prepublishOnly` 会再跑一遍测试。发布后确认：

```bash
npm view dsh-chat-history-editor version
npm view dsh-chat-history-editor dist.tarball
```

可选（推荐用于公开插件）：在 GitHub Actions 里用 `npm publish --provenance --access public`，给包附上可验证的构建来源。

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

## 3. 升级与回滚

- 改代码后 `npm version patch|minor|major`，重新 `npm publish`。
- 已装旧版本时，Plugin Manager 的 `install_bundle` 会返回 `already-installed`；用 Plugins 页面的 Update（内部是“先移除再安装”），或先 `remove_bundle` 再安装新 target。
- 没有 HMR 的 profile 安装/升级后需要重启；`web` profile 默认启用 HMR，安装后即时生效。
- 改动了 `engines.dsh`（例如需要更新的 DSH）时，旧运行时会被拒绝并给出 `incompatible-version`；管理员可按 Plugin Manager 的 `list_version_exemptions` / `set_version_exemption` 流程临时放行（有风险确认）。
- 注意 semver 预发布语义：`>=0.2.1-rc.2` 这类范围只覆盖同一 `major.minor.patch` 元组（0.2.1）的预发布版；DSH 升级到新的 minor（如 0.3.0-rc.1）后，需要发一个新插件版本并把 `engines.dsh` 更新到相应范围（或由用户走兼容性豁免）。
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
