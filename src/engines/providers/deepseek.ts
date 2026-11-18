/**
 * DeepSeek 通用上游 provider：仅在 general 查询中与 searxng 并发。
 *
 * - `raw`：调用 DeepSeek Search API，官方 rerank_score 用于源内排序 / min_score；
 * - `harness`：模拟 DeepSeek Harness 的 Messages + `deepseek_web_search`，无原始分。
 *
 * 运行期 secrets 已解析；CLI 的 available() 可能拿到 `env:NAME` 原文，需再解析一次。
 */

import type {
  EngineProvider,
  EngineProviderContext,
  GatewayUpstreamOptions,
} from "../provider.js";
import { asObject, dig, nonEmptyString, numberOr } from "../values.js";
import { searchDeepSeekHarness, searchDeepSeekRaw } from "../../search/deepseek.js";
import { resolveSecretValue } from "../../settings/secret-ref.js";
import { secretEnvNameForPath } from "../../settings/secrets.js";

const DEFAULT_RAW_BASE_URL = "https://api.deepseek.com/v1/tools";
const DEFAULT_HARNESS_BASE_URL = "https://api.deepseek.com/anthropic/v1";

function deepseekConfig(ctx: EngineProviderContext): Record<string, unknown> {
  return asObject(asObject(ctx.config.search).deepseek);
}

/** CLI 传入的密钥可能是 `env:NAME`，解析后再判断；只放在环境变量里时也可见。 */
function secret(ctx: EngineProviderContext): string {
  const value = dig(ctx.secrets, ["search", "deepseek", "api_key"]);
  const resolved = resolveSecretValue(nonEmptyString(value) ?? "").trim();
  if (resolved.length > 0) return resolved;
  const envName = secretEnvNameForPath(["search", "deepseek", "api_key"]);
  return envName === undefined ? "" : (process.env[envName] ?? "").trim();
}

export const deepseekProvider: EngineProvider = {
  id: "gateway.upstream:deepseek",
  group: "gateway.upstream",
  name: "deepseek",
  kind: "gateway",
  displayName: "DeepSeek",
  routing: () => ["general"],
  requires: ["secrets.search.deepseek.api_key"],
  available: (ctx) => secret(ctx).length > 0,
  enabled: (ctx) => deepseekConfig(ctx).enabled === true,
  enabledPath: ["search", "deepseek", "enabled"],
  authHint: "在 secrets.yaml 配置 search.deepseek.api_key，或设置 DEEPSEEK_API_KEY 环境变量。",
  runtime: {
    kind: "upstream",
    search(query: string, options: GatewayUpstreamOptions, ctx) {
      const config = deepseekConfig(ctx);
      const apiKey = secret(ctx);
      if (!apiKey) {
        return Promise.resolve({
          ok: false as const,
          error: { kind: "auth" as const, message: "DeepSeek 未配置 API key" },
          latencyMs: 0,
        });
      }

      // 配置里的 limit 是单源上限；服务层还会按最终条数截断。
      const limit = Math.max(1, Math.min(options.limit, numberOr(config.limit, 10)));

      if (config.mode === "harness") {
        const harness = asObject(config.harness);
        return searchDeepSeekHarness(query, {
          baseUrl: nonEmptyString(harness.base_url) ?? DEFAULT_HARNESS_BASE_URL,
          apiKey,
          timeoutMs: numberOr(harness.timeout_ms, 60_000),
          limit,
          model: nonEmptyString(harness.model) ?? "deepseek-flash",
          maxTokens: numberOr(harness.max_tokens, 4096),
          apiVersion: nonEmptyString(harness.api_version) ?? "2023-06-01",
        });
      }

      const api = asObject(config.api);
      return searchDeepSeekRaw(query, {
        baseUrl: nonEmptyString(api.base_url) ?? DEFAULT_RAW_BASE_URL,
        apiKey,
        timeoutMs: numberOr(api.timeout_ms, 20_000),
        limit,
        needContent: api.need_content === true,
        localization: nonEmptyString(api.localization) ?? "",
        minScore: options.minScore,
      });
    },
  },
};
