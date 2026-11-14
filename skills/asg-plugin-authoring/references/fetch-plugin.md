# fetch 插件契约

`src/index.ts` 导出命名 `fetch`，对象形状如下（与网关 `FetchPlugin` 一致）：

```ts
export interface FetchPlugin {
  id: string;
  platform: string;
  name: string;
  displayName: string;
  aliases?: readonly string[];
  settingsKey?: string;
  capabilities: readonly string[];
  requires?: readonly FetchPluginRequirement[];
  channels?: readonly FetchChannel[];

  match(url: URL): boolean;                                   // 纯 URL 判断
  enabled?(ctx: FetchPluginContext): boolean;                 // 统一开关
  available?(ctx: FetchPluginContext): boolean;               // 维护面可用性
  fetch(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult>;
}
```

## match

- 只读 URL：不读配置、不发请求、**不抛错**；
- 只接管自己真正能处理的路径，避免误伤同域其它页面；
- 命中范围要稳定：不要因为 query 里出现某个参数就接管整站；
- 需要用户显式请求时，约定一个参数（如微博用 `?weibo=post`），否则回退通用抓取。

## enabled / available

- `enabled(ctx)`：统一开关。返回 `false` 时宿主跳过插件，回退通用抓取；
  通常读 `ctx.settings.<plugin>.enabled`。
- `available(ctx)`：只用于维护面（健康检查 / `asg` 列表），**不参与** URL 匹配。
  常用来检查命令是否存在、密钥是否配置。
- 可选 `enabled` 表示始终启用。

## fetch 结果

```ts
export interface FetchPluginResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  bytes?: Buffer;         // 二进制或文本产物
  html?: string;          // 或 HTML（宿主会转 Markdown）；与 bytes 二选一
  errorCode?: string;
  errorMessage?: string;
}
```

约定：

- 文本用 `Buffer.from(text, "utf8")` + `contentType`（例如 `application/json`）；
- PDF/图片等直接返回 `bytes` + `contentType`；
- 失败时 `ok: false`，给出稳定 `errorCode`（例如 `NOT_SUBSCRIBED`、`NO_PDF`），
  `errorMessage` 面向 agent，尽量可操作；
- 需要提示操作时，在 `errorMessage` 末尾追加 `\n处理：<hint>`（与内置插件风格一致）。

## context

```ts
export interface FetchPluginContext {
  settings: FetchPluginSettings;      // 与 gateway.yaml 同形的切片
  secrets: FetchPluginSecrets;        // 与 secrets.yaml 同形的切片
  getSecret(path: string): string | undefined;
  logger?: Logger;                    // debug/info/warn/error，可缺省
  pluginConfig?: unknown;             // 外部插件的自定义配置
}
```

- 设置字段用 snake_case，与 `gateway.yaml` 完全一致；
- 只声明自己真正读到的字段（结构类型即可，宿主会传完整对象）；
- 不要读环境变量里的密钥，走 `ctx.secrets` / `ctx.getSecret`。

## 插件自行负责的事

网关**不**向插件传递 headers / cookies / 会话，也不干预重定向。因此：

- 自己设置 `User-Agent`、`Referer`、Cookie；
- 自己做逐跳重定向与登录态处理；
- 自己做大小上限（`fetch.max_download_bytes` 之类）与超时；
- 自己限制目标域名（例如只允许 `*.cnki.net`），避免被摘要页里的外链带出站。

## 二进制与大文件

- 先看 `content-length`，超限直接 cancel 响应体；
- 流式累计字节，超过上限立即 `reader.cancel()`，不要把整个文件读进内存再判断；
- 用魔数判断真实类型（例如 `%PDF-`），不要只信 `Content-Type`。

## match 与 enabled 的区别

| 场景 | 用哪个 |
| --- | --- |
| “这个 URL 归不归我管” | `match` |
| “用户是否启用了这个平台” | `enabled` |
| “依赖是否装好 / 密钥是否配置” | `available` |

`enabled` 返回 false 后宿主会回退到通用抓取，因此不要在 `match` 里读开关。

## 实现建议

- `src/index.ts` 只做再导出，实现放 `src/plugin.ts`（避免 `export const fetch` 遮蔽全局 `fetch`）；
- 需要 CLI 时复制 `runCliProcess` 到 `src/sdk/cli.ts`，永不 `shell: true`；
- 需要多后端路由时，把失败映射成稳定错误码，日志只写 debug；
- 把错误码/端点导出成变量，方便测试指向本地桩服务器。
