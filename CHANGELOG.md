# Changelog

本项目遵循语义化版本，条目按版本倒序。

## [0.3.6] - 2026-11-15

### Added

- 新增只读数据面命令 `asg search` / `asg fetch`：以 MCP 客户端调用运行中的网关，支持 `--json`（endpoint / 耗时 / 错误码 / 完整文本），不写配置、不重启服务。
- `fetch` 新增 `render: auto | always | never`（默认 `auto`）：内容判空后自动升级浏览器渲染；`always` 强制，`never` 关闭。
- `asg fetch` 新增 `--render`，`--json` 输出带本次渲染模式。
- 新增 ADR-0020：按转换后的正文判断 JS 空壳，不再看 HTML 体积。

### Changed

- MCP `search` / `fetch` 失败时返回 `isError: true`；CLI 同时兼容旧网关的 `[SEARCH_*]` / `[FETCH_*]` 前缀。
- fetch 的 JS 渲染判定改为“正文可见字符数 + script/SPA/noscript 特征”；大体积 SPA 空壳不再漏判。
- JS 空壳优先本地 playwright，失败再 FlareSolverr；CF/403 仍保持 FlareSolverr 优先。
- 误判时同时保留 direct 与渲染结果，按正文长度取更长者。
- playwright 渲染改为 `commit` + 有界 `domcontentloaded` / `networkidle` + 正文轮询；并发渲染串行化，避免共享 page 互相导航。
- `html2md` 把 `data:` URI 图片落盘为 `/files/<id>` 链接（单张 2MB、单次 10MB / 20 张），避免 base64 占满上下文或被当作正文。
- README / CLI 契约补充 search / fetch 与 render 说明；ADR-0018 增加只读数据面例外。

### Fixed

- JS 渲染页面返回空字符串却 `exit 0`；现在渲染后仍无正文返回 `[FETCH_RENDER_FAIL]`。

## [0.3.4] - 2026-11-15

### Breaking

- **不再支持 Docker 部署**：删除 `docker/`、`Dockerfile`、`.dockerignore` 与 docker 镜像 workflow；安装器只接受 `--searxng-mode auto | native | external`。
- `bilibili` / `weibo` / `cnki` 三个内置抓取插件迁出核心，改由官方插件仓库安装；核心不再内置对应实现。

### Added

- 第三方扩展运行时加载：扫描 `data/extensions/<id>/`，按 `asg-plugin.json` 的 `provides` 读取命名导出 `fetch` / `engine`。
- fetch 注册表与 gateway engine 注册表支持外部插件注入；同 id 外部实现优先。
- 新增官方插件仓库与 `asg extensions install` 安装流程（单文件 ESM + SHA256SUMS）。
- 新增插件编写 skill，方便把插件开发交给 AI。

### Changed

- `asg engines list/enable/disable` 会先加载已安装的 search 插件。
- 原生 searxng 的 settings 模板与 quota 种子迁移到 `searxng-ext/`。

### Fixed

- 移除 `bilibili` / `weibo` / `cnki` 作为扩展 id 的安装拦截，官方插件可正常安装与卸载。

## [0.3.3] - 2026-11-15

### Added

- 第三方插件声明与安装薄层：`asg-plugin.json` 约定 `provides`（`search` / `fetch` / 两者），新增 `asg extensions search|install|list|remove`。
- 安装器从 GitHub Release 下载 `asg-plugin.json`、单文件 ESM `entry` 与 `SHA256SUMS`，校验后原子写入 `data/extensions/<id>/`；内置 id（`bilibili` / `weibo` / `cnki`）拒绝覆盖。
- 新增 `docs/extensions.md` 与 `examples/asg-plugin/` 模板（单文件 esbuild + `v*` tag 发布 workflow）。
- 当前只完成安装，网关不 import 插件、不重启整栈；运行时加载留到后续版本。

### Fixed

- 修复 Arch 下 FlareSolverr 自带 `libreadline` 与系统 `/bin/sh` 冲突：自检命中后禁用内置 readline 并重试。
- 服务管理器按安装根匹配：同名 systemd / launchd / schtasks 项属于其他安装根时回退 pid，安装器也不再覆盖其他 root 的自启项。
- 服务端测试固定 searxng 不可达端口，避免本机已有 searxng 时误判。

## [0.3.2] - 2026-11-14

### Added

- 抓取插件统一契约：`bilibili` / `weibo` / `cnki` 规范平台 ID 与别名归一化。
- 新增 `FetchPluginRegistry`，重复 ID fail-fast，统一 `enabled` 过滤；禁用后回退通用抓取。
- 新增 `env:NAME` 密钥引用与 `getSecretAtPath`，`secrets.yaml` 可引用环境变量。
- 新增 `FetchChannel` / `CliChannel` / `HttpChannel` 通道契约。
- 新增 `runCliProcess`，Bilibili / Weibo CLI 统一进程执行，永不 `shell:true`。
- 新增通道注册表：`bilibili:kukemc` / `bilibili:ytdlp` / `bilibili:article` / `weibo:opencli` / `cnki:http`。
- `asg plugins` 输出 `platform` / `channel` / `channel_id`，输入接受规范通道 ID 与旧别名。
- 新增 `docs/fetch-plugin-contract.md`。

### Changed

- 抓取插件 `match(url)` 改为纯 URL；`enabled(ctx)` 统一过滤；`available(ctx)` 仅用于维护面。
- 插件增加 `platform` / `aliases` / `displayName` / `settingsKey` / `capabilities` / `requires` / `channels`。
- Bilibili / Weibo CLI 执行统一走 `runCliProcess`。
- `fetch` 工具描述补充平台与通道列表；`fetch` 输出统一使用规范平台 ID。

## [0.3.1] - 2026-11-14

### Added

- 网关原生引擎 provider 注册层：新增以图搜图源或文本源只需 provider 文件 + 注册表一行，CLI 与运行期共用同一份定义。
- `asg engines` 纳入 `gateway.search:weibo`，支持 `group:name` 限定名；同名引擎用限定名区分。
- 新增 `docs/engine-provider.md`，说明引擎 provider 协议与新增源的步骤。

### Changed

- `asg engines` 的表格改用 `ID`；JSON 新增 `id` / `group`，旧字段保持不变。
- 引擎写入改为多存储适配器先 plan、再统一校验和提交；写失败会回滚已写文件。
- 微博搜索启用依赖顶层 `weibo.enabled`，缺失时返回 `MISSING_DEPENDENCY`。
- 反向图搜与微博搜索改由 provider 注册表分发，不再在 `search/service.ts` 里按源名分支。

### Fixed

- 修复 searxng 的 `baidu` 引擎被误当成网关以图搜图源 `gateway.reverse_image:baidu` 的问题。

## [0.3.0] - 2026-11-14

### Added

- `asg` CLI：统一管理入口，覆盖 `status` / `start` / `stop` / `restart` / `serve` / `logs` / `config` / `engines` / `plugins` / `browser` / `adlist` / `update` / `doctor`。
- 稳定入口 `bin/asg.mjs`；systemd / launchd / 登录计划任务统一执行 `asg serve`。
- `asg status` 探测三个服务；`--json` / `--jsonl` 输出契约见 `docs/cli-contract.md`。
- `asg engines` 统一展示 searxng 引擎与网关原生源（`tracemoe` / `saucenao` / `baidu`）。
- `asg config` 用临时文件跑 `loadSettings()` 校验，写入前备份 `.bak`。

### Changed

- **破坏性变更：0.3.0 起必须重新安装**；旧的 `gateway.sh` / `gateway.ps1` / `start-all.*` / 后端壳 / 自更新壳已删除，不提供兼容层。
- 生命周期单位改为整栈：只提供 `start` / `stop` / `restart`，不再支持单组件重启。
- `--searxng-mode auto` 默认改为 `native`；Docker 模式仅保留给显式指定。
- 日志统一写入 `data/logs/<service>.log`，`asg logs` 默认合并 gateway + supervisor。
- 改配置 / 引擎 / 广告列表后整栈重启，MCP 连接会断开。

### Fixed

- `/health` 与 MCP `initialize` 返回的版本号不再硬编码 `0.1.0`，改为读取 `version.json` / `package.json`。
- `backends/cli.mjs` 支持 `--root`，安装版不再把插件写进版本目录。
- systemd 单元的 `WorkingDirectory` 不再加引号（否则 systemd 报 `bad unit file setting`，服务无法启动）。
- 安装器补齐 `data/installed.json`，`asg update check` 不再把已安装版本误判为“未安装”。
- 自更新脚本按安装布局向上查找安装根，修复安装版下读写错误 `data/` 的问题。
- FlareSolverr 增加启动自检：官方二进制在当前系统无法启动时自动关闭该能力，安装继续，不再让整栈启动失败。
- `asg adlist update`、`asg update`、`asg plugins install` 在代理环境下改用系统 curl，修复 Node fetch 不读取 `HTTPS_PROXY` 导致的下载失败。
- `asg update check` 返回 `current_version` / `up_to_date` / 目标版本；本地版本不低于远端时不再提示“有可用更新”。
- 正常参数错误与校验失败不再打印堆栈；`/health` 中成功项不再附带 `error: HTTP 200`，连接失败附带 `ECONNREFUSED` 等错误码。
- `asg doctor` 在 `flaresolverr.enabled=false` 时不再因 FlareSolverr 不可达而告警。

## [0.2.3] - 2026-11-10

### Fixed

- Windows 安装包改用 `pwsh` 的 `Compress-Archive` 生成标准 zip（`/` 分隔），避免 `Expand-Archive` 报“找不到中央目录结尾记录”。
- 完整包补上原生 searxng 安装所需资源：`docker/searxng/settings.template.yml`、`docker/searxng/quota.config.json`、`searxng-ext` 自定义引擎与 quota 插件。
- `self-update` 在 Windows 上优先使用 `Expand-Archive`，兼容旧版本包里的反斜杠条目。

## [0.2.2] - 2026-11-10

### Fixed

- 修复 Windows 安装包实际为 tar 归档的问题；改为 `Compress-Archive` 生成真正的 zip。
- `install.ps1` 增加 zip 文件头校验（`PK`），避免坏包进入解压流程。

## [0.2.1] - 2026-11-10

### Fixed

- `install.ps1` 兼容 `irm ... | iex`：移除 UTF-8 BOM 与 `param(...)` 块，改用 `$args` 解析参数。
- 用 `throw` / `return` 替代 `exit`，避免关闭用户的 PowerShell 会话。

## [0.2.0] - 2026-11-10

### Added

- 一键安装器：`scripts/install.sh`（Linux/macOS）与 `scripts/install.ps1`（Windows），支持 `curl | bash` / `irm | iex`。
- 跨平台依赖安装：searxng（Docker 或原生）、FlareSolverr、Playwright chromium。
- Windows 原生 searxng 的 `pwd` 补丁与 `searxng-ext` 集成。
- `scripts/start-all.mjs` supervisor 与 systemd/launchd/登录计划任务用户级自启。
- `runtime/pins.json` + CI `runtime.json`：依赖版本随网关发布固定。
- 自更新联动：依赖变化时 `--deps-only`，切换版本后 `--launch-only` 刷新启动清单。
