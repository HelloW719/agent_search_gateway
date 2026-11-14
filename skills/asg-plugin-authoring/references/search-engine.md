# engine（搜索源 / 图搜源）契约

`provides` 含 `"search"` 时，`entry` 必须导出命名 `engine`，形状为 `EngineProvider`：

```ts
export interface EngineProvider {
  id: string;                       // `${group}:${name}`
  group: "searxng" | "gateway.reverse_image" | "gateway.search";
  name: string;
  kind: "searxng" | "gateway";      // 第三方插件固定 "gateway"
  displayName: string;
  routing(ctx: EngineProviderContext): string[];
  requires?: string[];
  available(ctx: EngineProviderContext): boolean;
  enabled?(ctx: EngineProviderContext): boolean;
  enabledPath?: readonly string[];
  runtime?: EngineRuntime;
  authHint?: string;
}
```

## EngineProviderContext

```ts
export interface EngineProviderContext {
  config: Record<string, unknown>;   // 与 gateway.yaml 同形
  secrets: Record<string, unknown>;  // 与 secrets.yaml 同形
  pluginSecrets?: Record<string, string>; // 扩展密钥（已解析，空值不注入）
  logger?: Logger;
}
```

运行时传入的 `config` 是切片（例如 `{ search, weibo }`），因此读取时要用
`asObject(config.weibo).cli` 这类防御式写法，缺失字段要有默认值。

## 文本源：`gateway.search`

```ts
runtime: {
  kind: "search",
  plan(categories: string | undefined, ctx): { hot: boolean } | undefined,
  search(query: string, options: { hot: boolean; limit: number }, ctx): Promise<GatewaySearchResult>,
}
```

- `routing` 返回类别名列表：`["category:weibo", "category:weibo_hot"]`；
- 用户可以用 `asg engines route <engine> --category <name> [--hot-category <name>]` 覆盖
  `routing` / `plan`（宿主合成的 plan 优先 hot，再普通类别）；`--clear` 恢复插件默认；
- `plan` 只在类别命中时返回计划；不命中返回 `undefined`（宿主继续其它引擎）；
- `categories` 是逗号分隔字符串，大小写不敏感，用 `hasCategory(categories, name)` 判断；
- `hot: true` 表示热榜/热搜类查询，不需要关键词，`query` 可能为空；
- 返回结构：

```ts
type GatewaySearchResult =
  | { ok: true; results: SearxngResult[]; latencyMs: number }
  | { ok: false; error: { kind: "timeout" | "network" | "api" | "auth" | "invalid"; message: string }; latencyMs: number };
```

- `SearxngResult` 至少要有 `url` / `title`，建议填 `content` / `engine` / `score`；
- “没有结果”与“调用失败”要区分：空结果返回 `ok: true, results: []`，上游错误才 `ok: false`；
- 搜索页/浏览器型上游常有异步加载，建议空结果重试 + 短 TTL 缓存 + 并发限制。

## 图搜源：`gateway.reverse_image`

```ts
runtime: {
  kind: "reverse_image",
  search(input: ImageInput, ctx): Promise<SourceCall>,
}
```

```ts
type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; filename: string; mime: string };

type SourceCall =
  | { ok: true; results: SearxngResult[]; latencyMs: number; /* quota? remaining? */ }
  | { ok: false; error: { kind: "timeout" | "http" | "network" | "invalid_json" | "api"; status?: number; message: string } };
```

- `kind: "url"` 时直接请求图片 URL；`kind: "bytes"` 时用 multipart 上传；
- 返回候选结果，由宿主合并去重；
- 配额/限流信息可放在成功结果的附加字段里（如 `quota`、`remaining`）。

## enabled / available / enabledPath

- `available(ctx)`：密钥、上游开关等前置条件；**不包含**引擎自己的 enabled；
- `enabled(ctx)`：引擎自身开关；
- `enabledPath`：该布尔值在 `gateway.yaml` 中的路径（如 `["search", "weibo", "enabled"]`），
  `asg` 写回配置时使用；
- `requires`：人类可读的前置条件，例如 `["config:weibo.enabled"]`；
  `secret:<name>` 表示扩展密钥，读 `ctx.pluginSecrets[<name>]`，由
  `asg engines secret <engine> --name <name> --stdin` 写入 `secrets.yaml` 的
  `extensions.<engineId>.<name>`；缺失时宿主强制 `available()` 为 false。

## 示例

见 `examples/search-engine.ts`（文本源）。要点：

```ts
routing: (ctx) => [`category:${categoryOf(ctx)}`],
available: (ctx) => asObject(ctx.config.example).enabled === true,
enabled: (ctx) => asObject(asObject(ctx.config.search).example).enabled === true,
runtime: {
  kind: "search",
  plan: (categories, ctx) => hasCategory(categories, hotCategoryOf(ctx)) ? { hot: true } : undefined,
  search: async (query, { limit }, ctx) => ({ ok: true, results: await run(query, limit), latencyMs: 0 }),
}
```

## 调试建议

- 单测直接构造 `{ config, secrets }`，覆盖：
  - `routing()` 的类别列表；
  - `plan()` 的命中/不命中；
  - `available()` / `enabled()` 的开关组合；
  - `search()` 的成功、空结果、错误映射（用假 CLI 或本地 HTTP 桩）。
- 不要把 `plan` 写成会发请求的实现：它只做类别判断。
