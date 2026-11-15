# asg-plugin.json（manifest）

插件根目录必须包含 `asg-plugin.json`。网关用 zod **严格校验**：未知字段直接报错，
不允许注释、尾逗号或自定义字段。

## 字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；也是安装目录名 |
| `name` | 是 | 1–80 个字符的展示名 |
| `version` | 是 | 语义化版本 `\d+\.\d+\.\d+(-预发布)?`；必须与 Release tag 去掉 `v` 后一致 |
| `api_version` | 是 | 当前只接受字面量 `1` |
| `provides` | 是 | 非空数组，元素只能是 `"search"` / `"fetch"`，不能重复 |
| `entry` | 是 | 单个 `.mjs` / `.js` 文件名；不能含 `/`、`\`、`..`、`:`，不能是绝对路径 |
| `platform` | 否 | 小写字母/数字/`-`；作为 fetch 插件平台回退，缺省用 `id` |
| `description` | 否 | 任意字符串（建议一句话说明能力） |
| `config_schema` | 否 | 插件私有配置声明（JSON Schema 子集，见下文）；省略时 `config` 原样透传 |

## 示例

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "example.com 文章取件"
}
```

同时提供搜索源与取件：

```json
{
  "id": "weibo",
  "name": "Weibo",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["search", "fetch"],
  "entry": "index.mjs",
  "description": "微博取件 + weibo / weibo_hot 搜索源"
}
```

## 私有配置：`config_schema`

插件有自己的配置（开关、超时、上游地址、上限等）时，用 `config_schema` 声明。
网关会用它校验 `gateway.yaml → extensions.<id>.config`，补齐默认值，再注入
`ctx.pluginConfig`；没有声明时 `config` 原样透传。

```json
{
  "config_schema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true, "description": "总开关" },
      "base_url": { "type": "string", "description": "上游根地址" },
      "timeout_ms": {
        "type": "integer",
        "default": 15000,
        "minimum": 1000,
        "maximum": 60000,
        "description": "单次请求超时（毫秒）"
      },
      "mode": {
        "type": "string",
        "enum": ["fast", "full"],
        "default": "fast",
        "description": "抓取模式"
      }
    }
  }
}
```

支持的子集：

- 根必须是 `type: "object"` + `properties`（可为空对象）；
- 关键字：`type`（object/string/number/integer/boolean/array）、`description`、
  `default`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`items`、
  `properties`、`required`、`additionalProperties`；
- 省略 `additionalProperties` 按 `false`（未知键直接拒绝）；
- 递归深度 ≤ 8（根算第 1 层），节点总数 ≤ 256；
- 不支持 `$ref`、`pattern`、`oneOf` / `anyOf` / `allOf`、`format`；出现即报错；
- `default` 必须能通过该节点自己的 schema。
- `enum` 必须是非空数组，元素只能是字符串、数字或布尔值。

用户侧命令：

```bash
asg extensions config <id>
asg extensions config <id> --describe
asg extensions config <id> --set timeout_ms=20000
asg extensions secret <id> --name api_key --stdin
```

配置存 `extensions.<manifest id>.config`（键是 manifest id，不是 engineId）；
写入前校验，失败不落盘；成功后整栈重启。默认值只在运行期补齐，不写回文件。
**密钥不要放进 `config`**，一律用 `secrets.yaml → extensions.<id>.<name>`。

字段命名规范见 `../SKILL.md` 的“插件私有配置”一节：统一 snake_case，
`enabled` / `base_url` / `timeout_ms` / `limit` / `categories` / `mode` / `user_agent`，
单位写进后缀，布尔用肯定式。

## provides 与命名导出的对应关系

| `provides` | 运行期从 `entry` 读取的导出 |
| --- | --- |
| `["fetch"]` | `fetch` |
| `["search"]` | `engine` |
| `["search", "fetch"]` | `engine` 与 `fetch` 同时存在 |

导出名写错时，安装本身可能成功（当前安装层只校验资产与 manifest），但运行期加载会
失败或该能力不生效，因此务必在测试里断言导出形状。

## 安装目录与状态

- 安装根目录：`<root>/data/extensions/<id>/`，目录名必须与 `id` 一致；
- 目录存在即视为已安装，没有额外注册表；
- 安装时先下载到 `.staging-*`，成功后原子换入；旧目录进 `.trash-*`；
- 卸载只删目录，不改 `gateway.yaml` / `secrets.yaml`。

## 资产

一个 Release 至少包含：

| 资产 | 说明 |
| --- | --- |
| `asg-plugin.json` | manifest 本体 |
| `index.mjs`（或 `entry` 指定的文件） | 单文件 ESM，不能依赖同目录其它文件 |
| `SHA256SUMS` | `sha256sum` 格式，必须覆盖前两者 |

安装器只接受 **https** 下载地址，并会先校验 manifest，再按 `SHA256SUMS` 校验两个文件；
校验失败立即清理 staging。

## 版本与内置 id 注意事项

- tag 建议用 `v<version>`；安装器也兼容不带 `v` 的 tag，但 `version` 必须与 tag 对应。
- 从网关 **0.3.4** 起，`bilibili` / `weibo` / `cnki` 已迁出为官方插件仓库，可以按上述 id 安装；
  0.3.3 及更早版本会把这些 id 当作内置能力拒绝安装/卸载，先升级网关。
- 私有仓库的 Release 资产目前不保证可安装（下载不带 Release asset API 鉴权）。
