/**
 * 最小可复制的 fetch 插件示例。
 *
 * 放到插件仓库的 `src/plugin.ts`，再由 `src/index.ts` 做：
 *
 *   import { examplePlugin } from "./plugin.js";
 *   export const fetch = examplePlugin;
 *
 * 注意：入口模块一旦 `export const fetch`，该模块内的 `fetch(...)` 会解析到这个绑定，
 * 因此实现里统一用 `globalThis.fetch`（或把实现留在 plugin.ts）。
 *
 * 依赖的类型来自 `src/sdk/`（从网关复制的契约类型），不要 import 网关包。
 */
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "./sdk/fetch-plugin.js";

const ARTICLE_PATH = /^\/article\/(\d+)(?:\/|$)/;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 读取插件自己的配置段（gateway.yaml 里的 `example:`）。
 *
 * 也可以在 `src/sdk/settings.ts` 里补一个 `ExampleSettings` 接口拿到强类型；
 * 这里用防御式读取，保证字段缺失时仍有默认值。
 */
function exampleSettings(ctx: FetchPluginContext): { enabled: boolean; timeoutMs: number } {
  const settings = ctx.settings as unknown as Record<string, unknown>;
  const raw = settings.example;
  const conf = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: conf.enabled !== false,
    timeoutMs: typeof conf.timeout_ms === "number" ? conf.timeout_ms : 15000,
  };
}

async function fetchArticle(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { enabled, timeoutMs } = exampleSettings(ctx);
  if (!enabled) {
    return {
      ok: false,
      finalUrl: url.toString(),
      errorCode: "EXAMPLE_DISABLED",
      errorMessage: "example 插件未启用（example.enabled=false）",
    };
  }

  let res: Response;
  try {
    // 插件自管 headers / 重定向 / 超时；这里只接受同域跳转。
    res = await globalThis.fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = (err as Error)?.name === "TimeoutError";
    return {
      ok: false,
      finalUrl: url.toString(),
      errorCode: timeout ? "EXAMPLE_TIMEOUT" : "EXAMPLE_NETWORK",
      errorMessage: timeout ? `请求超时（>${timeoutMs}ms）` : `请求失败：${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      status: res.status,
      finalUrl: res.url || url.toString(),
      errorCode: "EXAMPLE_HTTP",
      errorMessage: `example.com 返回 HTTP ${res.status}`,
    };
  }

  // 纯 HTML 交给宿主转 Markdown；需要结构化输出时改成 bytes + application/json。
  const html = await res.text();
  ctx.logger?.debug(`example: ${url.pathname} → ${html.length} chars`);
  return {
    ok: true,
    status: res.status,
    contentType: "text/html",
    finalUrl: res.url || url.toString(),
    html,
  };
}

export const examplePlugin: FetchPlugin = {
  id: "example",
  platform: "example",
  name: "example",
  displayName: "Example",
  aliases: ["示例"],
  settingsKey: "example",
  capabilities: ["article"],

  /** 纯 URL 判断：不读配置、不发请求、不抛错。 */
  match(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    const onHost = host === "example.com" || host.endsWith(".example.com");
    return onHost && ARTICLE_PATH.test(url.pathname);
  },

  /** 统一开关：false 时宿主回退通用抓取。 */
  enabled: (ctx) => exampleSettings(ctx).enabled,

  /** 维护面可用性：这里没有额外依赖。 */
  available: () => true,

  fetch: fetchArticle,
};
