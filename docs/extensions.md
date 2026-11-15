# 第三方扩展：声明与安装

本文说明第三方插件（extension）的 manifest、发布资产、安装目录与 `asg extensions` 命令。

> **当前范围**：插件声明、安装薄层与运行时加载。网关启动（或 `asg engines list`）时会扫描
> `data/extensions` 并 import 已安装插件；安装命令本身仍**不会重启**网关，需要重启一次让新插件生效。
> 权限与沙箱仍留到后续版本。

## 1. 安装目录与状态

- 安装根目录：`<root>/data/extensions/<id>/`
- **目录存在即视为已安装**，不额外维护注册表或数据库；目录名必须与 manifest 的 `id` 一致。
- 安装过程中会短暂出现 `.staging-*` 与 `.trash-*` 目录；命令结束后会清理。
- 卸载只删除 `data/extensions/<id>`，不修改 `gateway.yaml` / `secrets.yaml`；
  插件的 `extensions.<id>.config` 与 `extensions.<id>.<name>` 会保留，需要时手动清理。
- `asg extensions list` 遇到损坏的安装目录时只把该条标记为错误（JSON 里有 `error` 字段），不会让整条命令失败。

`bilibili`、`weibo`、`cnki` 是官方插件 id：核心不再内置对应实现，需通过
`asg extensions install` 安装官方插件仓库；安装后由扩展机制加载。

## 2. manifest：`asg-plugin.json`

插件根目录必须包含 `asg-plugin.json`，字段严格校验（未知字段直接报错）：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；安装目录名必须与它一致 |
| `name` | 是 | 1–80 个字符的显示名 |
| `version` | 是 | 语义化版本，如 `1.2.3`、`1.2.3-beta.1`；必须与 Release tag 去掉 `v` 后一致 |
| `api_version` | 是 | 当前只接受字面量 `1` |
| `provides` | 是 | 非空数组，元素只能是 `"search"` / `"fetch"`，不能重复 |
| `entry` | 是 | 单个 `.mjs` / `.js` 文件名；不能含 `/`、`\`、`..`，不能是绝对路径 |
| `platform` | 否 | 小写字母/数字/`-`；作为 fetch 插件的平台回退，缺省用 `id` |
| `description` | 否 | 任意字符串 |
| `config_schema` | 否 | 插件私有配置的声明（JSON Schema 子集，见第 4 节）；省略时旧行为不变 |

示例：

```json
{
  "id": "example-fetch",
  "name": "Example Fetch Plugin",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "示例：接管 example.com 的抓取"
}
```

## 3. `provides` 的语义

| 值 | 含义 | 运行时约定 |
| --- | --- | --- |
| `search` | 提供搜索源/搜索计划 | 从 `entry` 读取命名导出 `engine` |
| `fetch` | 提供抓取实现 | 从 `entry` 读取命名导出 `fetch` |
| `["search", "fetch"]` | 同时提供两类能力 | 同一文件可同时导出 `engine` 与 `fetch` |

`provides` 同时决定运行时校验：`fetch` 必须导出带 `match` / `fetch` 函数的对象，
`search` 必须导出带 `id` / `group` / `name` / `runtime` 的对象。导出缺失或类型不符时，
该插件会被跳过并在日志中告警，不影响其它插件与内置实现。

## 4. 插件私有配置（`config_schema`）

插件可以在 manifest 里用可选的 `config_schema` 声明自己的配置。网关用这份 schema 校验
`gateway.yaml → extensions.<manifest id>.config`，补齐默认值，再把结果以只读对象注入
`ctx.pluginConfig`；密钥则单独走 `secrets.yaml` 与 `ctx.pluginSecrets`。

没有 `config_schema` 的旧 manifest 行为不变：`config` 原样透传（必须是对象），空对象不注入。

### 4.1 manifest 示例

```json
{
  "id": "example-fetch",
  "name": "Example Fetch Plugin",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "timeout_ms": {
        "type": "integer",
        "default": 15000,
        "minimum": 1000,
        "maximum": 60000,
        "description": "单次请求超时（毫秒）"
      },
      "user_agent": { "type": "string", "description": "自定义 User-Agent；缺省用插件内置值" },
      "mode": { "type": "string", "enum": ["fast", "full"], "default": "fast", "description": "抓取模式" }
    }
  }
}
```

### 4.2 用户配置

```yaml
# gateway.yaml
extensions:
  example-fetch:            # manifest id，不是 engineId
    config:
      timeout_ms: 20000
```

- 键是 **manifest 的 `id`**（安装目录名），不是 `gateway.search:weibo` 这类 engineId。
- 默认值只在运行期补齐，不写回 `gateway.yaml`；`asg extensions config` 也只落盘用户显式设置的值。
- 读取完整配置（含默认值）：`asg extensions config example-fetch`。

### 4.3 支持的 JSON Schema 子集

根节点必须是 `type: "object"` 且声明 `properties`（可以是空对象）。每个节点支持：

`type`、`description`、`default`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、
`items`、`properties`、`required`、`additionalProperties`。

- `type` 只能是 `object` / `string` / `number` / `integer` / `boolean` / `array`；
- `enum` 必须是非空数组，元素只能是字符串、数字或布尔值；
- 省略 `additionalProperties` 时按 `false` 处理（拒绝拼写错误与未知键）；
- 递归深度 ≤ 8（根节点算第 1 层），schema 节点总数 ≤ 256；
- 不支持 `$ref`、`pattern`、`oneOf` / `anyOf` / `allOf`、`format` 等关键字；
  出现未知关键字会直接报错，不会静默忽略；
- `default` 必须能通过该节点自己的 schema，否则 manifest 校验失败。

### 4.4 校验、默认值与失败行为

- 加载时先校验 manifest 与 `config_schema` 定义，再校验用户配置；未知键、类型错误、
  枚举越界、`required` 缺失都会让该插件**整包跳过**，只记录 error + warn，不影响其它插件与网关启动。
- 配置不合法时不会 `import` 插件入口模块。
- `asg extensions config` 写前用同一套 schema 校验；失败返回 `CONFIG_INVALID`，
  **不写文件、不重启**，目标文件保持原样。
- 读取时补默认值；`--set` / `--unset` / `--file` 写入的始终是原始用户值，默认值不落盘。

### 4.5 运行期上下文

`search` 插件（`EngineProviderContext`）与 `fetch` 插件（`FetchPluginContext`）都会收到：

```ts
ctx.pluginConfig?: Readonly<Record<string, unknown>>; // 已补默认值并递归冻结
ctx.pluginSecrets?: Record<string, string>;           // 已解析 env:，空值不注入
```

- `pluginConfig` 来自 `extensions.<manifest id>.config`；声明了 `config_schema` 时即使
  用户没写配置也会注入补齐默认值后的对象。
- `pluginSecrets` 合并 `extensions.<manifest id>.<name>` 与旧的
  `extensions.<engineId>.<name>`，同名时 manifest id 优先。
- fetch 的 `match(url)` **不注入配置**：只能看 URL；`enabled` / `available` / `fetch` 才能读 `ctx.pluginConfig`。
- `ctx.config` / `ctx.secrets`（fetch 侧是 `ctx.settings` / `ctx.secrets`）是核心内置实现使用的
  配置切片，不属于第三方扩展的稳定契约；第三方扩展只读 `pluginConfig` / `pluginSecrets`。
- `requires: ["secret:<name>"]` 只声明依赖；缺失时宿主强制 `available()` 返回 false。

### 4.6 密钥

```yaml
# secrets.yaml
extensions:
  example-fetch:
    api_key: env:EXAMPLE_API_KEY
```

- 新键是 `extensions.<manifest id>.<name>`；旧的 `extensions.<engineId>.<name>` 继续兼容，
  同名时 manifest id 覆盖 engineId。
- `asg extensions secret <id> --name <name> --stdin` 写新键；
  `asg engines secret <engine> --name <name> --stdin` 仍按 engineId 写旧键。
- 密钥**不放** `config` / `gateway.yaml`；`config_schema` 只描述非敏感配置。

### 4.7 字段命名规范

配置字段统一 **snake_case**，优先复用核心词汇；禁止同义混用。发布后不改字段语义。

| 语义 | 统一字段 | 类型 | 避免 |
| --- | --- | --- | --- |
| 总开关 | `enabled` | boolean | `enable`、`disabled`、`active` |
| 上游根地址 | `base_url` | string | `api_base`、`endpoint`、`host` |
| 超时 | `timeout_ms` | integer | `timeout`、`timeout_sec` |
| 单次结果上限 | `limit` | integer | `max`、`count`、`page_size` |
| 分资源上限 | `<resource>_limit` | integer | `limit_<resource>` |
| 重试次数 | `max_retries` | integer | `retry`、`retries` |
| 重试退避 | `retry_backoff_ms` | integer | `backoff`、`retry_delay` |
| 缓存时长 | `cache_ttl_ms` | integer | `ttl`、`cache_seconds` |
| 字节/字符上限 | `max_bytes` / `max_chars` | integer | `max_size`、`max_length` |
| 语言 | `languages` | string[] | `lang`、`language` |
| 类别 | `categories`；单值用 `category` | string[] / string | `category_list` |
| 模式 | `mode` + `enum` | string | `type`、`kind` |
| 文件/目录 | `*_path` / `*_dir` | string | `*_file`、`*_folder` |
| 用户代理 | `user_agent` | string | `ua` |
| 密钥 | 不放 config | — | 一律走 `pluginSecrets` |

补充规则：

- 单位写进后缀（`timeout_ms`、`cache_ttl_ms`、`max_bytes`）；
- 布尔用肯定式（`enabled`，不要 `disabled`）；
- 每个字段都写 `description`；能安全默认的写 `default`；
- 每个 object 层级显式或隐式 `additionalProperties: false`；
- 同一语义只用一个名字，避免 `timeout` / `timeout_ms` 并存。

## 5. 发布资产

一个插件 Release（推荐 tag 为 `v<version>`，例如 `v0.1.0`；安装器也兼容不带 `v` 的 tag）至少包含三个资产：

| 资产 | 必填 | 说明 |
| --- | --- | --- |
| `asg-plugin.json` | 是 | manifest 本体 |
| `index.mjs`（或 manifest `entry` 指定的文件名） | 是 | 单文件 ESM 产物；不能依赖同目录其它文件 |
| `SHA256SUMS` | 是 | `sha256sum` 格式，必须覆盖 manifest 与 entry |

生成并发布示例：

```bash
npm ci
npm run build
sha256sum index.mjs asg-plugin.json > SHA256SUMS
gh release create v0.1.0 index.mjs asg-plugin.json SHA256SUMS
```

安装器会：

1. 解析 GitHub Release（指定版本时先查 `v<version>`，再回退到 `<version>`；否则查 `latest`）。
2. 先下载 `asg-plugin.json` 到 staging 并校验。
3. 再下载 `entry` 与 `SHA256SUMS`。
4. 用 `SHA256SUMS` 校验 manifest 与 entry；缺失或不匹配立即失败并清理 staging。
5. 旧目录移到 `.trash-*`，staging 原子换到 `data/extensions/<id>/`；失败时回滚旧目录。

所有下载地址只接受 **https**。下载复用 `scripts/install/http.mjs`，因此会自动遵循
`HTTPS_PROXY` / `https_proxy` 等代理变量。

限制：私有仓库的 Release 资产目前按 `browser_download_url` 下载，不会额外带
GitHub Release asset API 的鉴权；私有仓库安装暂不保证可用。

## 6. CLI

```text
asg extensions search [query] [--limit N]
asg extensions install <owner/repo>[@version]
asg extensions list
asg extensions remove <id>
asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
asg extensions secret <id> --name <name> --stdin | --clear
```

- `search`：搜索 GitHub 上带 `topic:asg-plugin` 的公开仓库；默认按更新时间倒序。
- `install`：从 `owner/repo` 的 GitHub Release 安装；`@version` 可锁定版本。
- `list`：表格输出 `ID / VERSION / PROVIDES / ENTRY`；JSON 模式返回 `{ "extensions": [...] }`。
- `remove`：删除 `data/extensions/<id>`。
- `config`：读写 `gateway.yaml → extensions.<id>.config`。
  - 无参数：输出补齐默认值后的完整配置；
  - `--get [key]`：只输出一个字段（支持 `retry.times` 这类点号路径）；不给 key 时输出整份配置；
  - `--set key=value`：可重复，值先按 JSON 解析，失败按字符串；
  - `--unset key`：可重复；
  - `--file <path>`：用 YAML/JSON 文件整体替换配置；
  - `--describe`：列出 schema 的顶层字段（类型、必填、默认值、说明）。
- `secret`：写/删 `secrets.yaml → extensions.<id>.<name>`。值只从 stdin 读，
  末尾一个换行会被去掉；`--clear` 删除；输出不回显明文。

示例：

```bash
asg extensions search bilibili
asg extensions install someone/asg-plugin-example@0.1.0
asg extensions list
asg extensions list --json
asg extensions remove example-fetch

asg extensions config example-fetch
asg extensions config example-fetch --describe
asg extensions config example-fetch --get timeout_ms
asg extensions config example-fetch --set timeout_ms=20000 --set user_agent=asg-example
asg extensions config example-fetch --unset user_agent

echo "$EXAMPLE_API_KEY" | asg extensions secret example-fetch --name api_key --stdin
asg extensions secret example-fetch --name api_key --clear
```

所有子命令都支持全局 `--json`（输出单个 result 对象）；`config` / `secret` 的 JSON 字段见
`docs/cli-contract.md` 5.6.1。

`config` 没有声明 `config_schema` 时按原样透传，`--describe` 会提示未声明。
所有写入命令都是**先整体校验、再写一次文件、最后整栈重启一次**；校验失败不落盘、不重启。
`secret` 写入的 `secrets.yaml` 权限固定为 `0600`。

安装成功后人类输出会明确提示：

```text
重启网关后生效。
```

### GitHub API 限流

`search` 以及私有仓库的 Release 查询会读取 `GITHUB_TOKEN`（或 `GH_TOKEN`）。
未设置 token 时 GitHub 对匿名请求限制较严；遇到 403 / 429 时请设置 token 后重试：

```bash
export GITHUB_TOKEN=ghp_xxx
```

请求头固定包含 `Accept: application/vnd.github+json`、
`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: asg/<version>`；有 token 时加
`Authorization: Bearer <token>`。

## 7. 安全与边界

- manifest 的 `id` 与 `entry` 都做了路径约束，安装目录不会逃出 `data/extensions/`。
- 只接受 https 资产地址，并用 `SHA256SUMS` 校验 manifest 与 entry。
- 官方 id（`bilibili` / `weibo` / `cnki`）与普通第三方 id 一样安装/卸载。
- 插件代码在网关进程内 import，**没有沙箱**；可读取宿主注入的
  `ctx.pluginConfig` / `ctx.pluginSecrets`（内置实现另用 `ctx.settings` / `ctx.secrets` / `getSecret()`）。
  只安装可信来源。
- `config_schema` / `extensions.<id>.config` **不放密钥**；密钥一律写
  `secrets.yaml → extensions.<id>.<name>`，用 `asg extensions secret --stdin` 输入，
  不进 argv、不回显。

## 8. 运行时加载

网关启动时（`createServer` 首次调用，进程级只执行一次）以及 `asg engines list|enable|disable|route|secret`
会扫描 `data/extensions`：

1. 读取 `data/extensions/<id>/asg-plugin.json`，校验 `api_version === 1`，目录名必须等于 `manifest.id`；
   `config_schema` 也会在这一步校验定义本身。
2. 按 manifest id 读取 `gateway.yaml → extensions.<manifest id>.config`，用 `config_schema`
   校验并补默认值；非法配置直接跳过该插件（不 import 入口）。
3. 解析 `secrets.yaml → extensions.<id>.<name>`（同时合并旧 `extensions.<engineId>.<name>`，
   manifest id 优先），解析 `env:NAME`，空值不注入。
4. `import()` 安装目录内 `entry` 指向的文件（单个 ESM 文件，不得引用其它插件文件）。
5. 按 `provides` 读取命名导出：
   - `fetch`：抓取插件对象（`match` / `enabled` / `available` / `fetch`），manifest 覆盖 `id` / `name` / `displayName` / `platform`；
   - `engine`：搜索源对象（`id` / `group` / `name` / `runtime` 等）。
6. 注入配置：包装 `enabled` / `available` / `fetch`，把 `pluginConfig`（递归冻结）与
   `pluginSecrets` 放进 `FetchPluginContext`；search 插件同样注入 `EngineProviderContext`。
   `match(url)` 保持原函数，不读配置。
7. 同一批外部插件内 id 重复视为扩展自身错误；重复插件会被跳过并记录错误。
8. 单个插件加载失败只影响该插件，不影响网关启动与其它插件。

只有声明了 `config_schema`，或存在非空 `config` / 非空密钥 / 路由覆盖 / `secret:` 依赖时，
provider 才会被包装；没有这些配置的插件保持原对象，行为与插件自身实现完全一致。

引擎插件的用户级覆盖进 `extensions` 段，键的语义不同：

```bash
asg engines route gateway.search:weibo --category news --hot-category news_hot
asg engines secret gateway.search:weibo --name cookie --stdin
asg extensions config weibo --set limit=20
asg extensions secret weibo --name cookie --stdin
```

- `routing` 写入 `gateway.yaml` 的 `extensions.<engineId>.routing`，覆盖插件的 `routing()` / `plan()`；
- 私有配置写入 `gateway.yaml` 的 `extensions.<manifest id>.config`，运行期通过
  `ctx.pluginConfig` 注入；
- 密钥写入 `secrets.yaml` 的 `extensions.<manifest id>.<name>`（新键）或
  `extensions.<engineId>.<name>`（旧键，继续兼容），支持 `env:NAME`，运行期通过
  `ctx.pluginSecrets` 注入；插件用 `requires: ["secret:<name>"]` 声明依赖。
  注意：`asg engines enable` 的依赖检查同时认两个键：先查
  `extensions.<manifest id>.<name>`，解析后为空（含 `env:` 为空）再回退
  `extensions.<engineId>.<name>`；任一非空即满足。

插件不得 import 网关内部模块，也不得依赖宿主 `node_modules` 中的非内置包；
需要跨进程能力时应通过 CLI / HTTP 自行实现。

插件模板见 `examples/asg-plugin/`，发布时请给仓库加 `asg-plugin` topic。
