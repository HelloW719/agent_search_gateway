import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineProvider } from "../src/engines/provider.js";
import { resetExternalEngineProvidersForTests, setExternalEngineProviders } from "../src/engines/registry.js";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import { createSearchService } from "../src/search/service.js";
import type { SearchSettingsDeps } from "../src/search/service.js";
import type { Settings } from "../src/settings/index.js";
import { deepMerge, makeSettings, searchServiceDeps, type DeepPartial } from "./helpers/settings.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

const domainFilter: DomainFilter = { enabled: false, blocked: new Set(), allowlist: new Set(), count: 0 };

const AVAILABLE_ENGINES = ["zhihu", "bilibili", "firecrawl", "tavily", "exaapi"];

/** 模拟官方 weibo 扩展注册的 gateway.search provider（无 runtime → 不接管搜索）。 */
const fakeWeiboProvider: EngineProvider = {
  id: "gateway.search:weibo",
  group: "gateway.search",
  name: "weibo",
  kind: "gateway",
  displayName: "Weibo",
  routing: () => ["weibo", "weibo_hot"],
  available: () => true,
};

let mockServer: ReturnType<typeof createHttpServer>;
let mockPort = 0;
/** `/config` 的 HTTP 状态：测试“配置取不到”时临时改 500。 */
let configStatus = 200;
/** 记录每次 `/search` 收到的 engines / categories 参数。 */
let searchCalls: Array<{ engines: string; categories: string }> = [];

function makeConfig(overrides: DeepPartial<Settings> = {}): SearchSettingsDeps {
  const base: DeepPartial<Settings> = {
    searxng: { url: `http://127.0.0.1:${mockPort}`, timeout_ms: 3000 },
    rerank: { enabled: false, engine_boost: {} },
  };
  return searchServiceDeps(makeSettings(deepMerge(base, overrides)));
}

beforeAll(async () => {
  mockServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/config") {
      if (configStatus !== 200) {
        res.statusCode = configStatus;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          categories: ["general", "news", "images", "science", "it", "videos", "other"],
          engines: [
            { name: "google", enabled: false },
            ...AVAILABLE_ENGINES.map((name) => ({ name, enabled: true })),
          ],
        }),
      );
      return;
    }
    searchCalls.push({
      engines: url.searchParams.get("engines") ?? "",
      categories: url.searchParams.get("categories") ?? "",
    });
    const q = url.searchParams.get("q") ?? "";
    const results =
      q === "empty"
        ? []
        : [{ url: "https://ok.example/1", title: "Hit", content: "hit", engine: "zhihu", score: 0.9 }];
    res.end(JSON.stringify({ results, unresponsive_engines: [] }));
  });
  await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", r));
  mockPort = (mockServer.address() as AddressInfo).port;
});

afterAll(() => {
  mockServer.close();
});

afterEach(() => {
  resetExternalEngineProvidersForTests();
  configStatus = 200;
});

describe("显式 engines 校验（复用 searxng /config）", () => {
  it("显式引擎全部不可用 → 参数错误且文案含请求名与可用引擎", async () => {
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "bad-engine", engines: "google" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SEARCH_INVALID");
    expect(r.text).toContain("指定引擎不可用");
    expect(r.text).toContain("google");
    expect(r.text).toContain("当前可用");
    expect(r.text).toContain("zhihu");
    // 未被认作可用 → 不应打到 /search
    expect(searchCalls).toHaveLength(0);
  });

  it("显式可用引擎 → 正常搜索（严格按该引擎）", async () => {
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "good-engine", engines: "zhihu" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hit");
    expect(searchCalls).toEqual([{ engines: "zhihu", categories: "" }]);
  });
});

describe("未知 categories 提示（复用 searxng /config）", () => {
  it("未知 category → 照常搜索，文末提示未被声明", async () => {
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "bad-category", categories: "bogus" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hit");
    expect(r.text).toContain("bogus");
    expect(r.text).toContain("未被 searxng 声明");
    expect(searchCalls).toEqual([{ engines: "", categories: "bogus" }]);
  });

  it("已知 category（大小写变体）不提示，且实际发送值不被改写", async () => {
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "news-cat", categories: "News" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hit");
    expect(r.text).not.toContain("未被 searxng 声明");
    // searxng 按字面匹配类别：只做校验比较，不改写请求
    expect(searchCalls).toEqual([{ engines: "", categories: "News" }]);
  });

  it("未注册 weibo 扩展 → categories=weibo_hot 提示安装扩展", async () => {
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "weibo-hot", categories: "weibo_hot" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("weibo_hot");
    expect(r.text).toContain("未被 searxng 声明");
  });

  it("注册 gateway.search provider 后，其 routing 声明的类别不再提示", async () => {
    setExternalEngineProviders([fakeWeiboProvider]);
    searchCalls = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "weibo-hot-ok", categories: "weibo_hot" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hit");
    expect(r.text).not.toContain("未被 searxng 声明");
    // 假 provider 没有 runtime → 不接管搜索，类别照常转发给 searxng
    expect(searchCalls).toEqual([{ engines: "", categories: "weibo_hot" }]);
  });

  it("provider.routing 抛错 → 跳过该 provider，搜索不失败", async () => {
    setExternalEngineProviders([
      {
        ...fakeWeiboProvider,
        id: "gateway.search:broken",
        name: "broken",
        routing: () => {
          throw new Error("boom");
        },
      },
    ]);
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "routing-broken", categories: "general" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Hit");
  });

  it("search_by_image 按配置值放行（不写死）", async () => {
    // 关闭反向图搜能力（避免真打图源）：类别校验仍按配置值判断
    const svc = createSearchService(
      makeConfig({ search: { reverse_image: { enabled: false } } }),
      domainFilter,
      silentLogger,
    );
    const r = await svc.search({ query: "", categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain("未被 searxng 声明");
  });

  it("自定义 reverse_image.category：新值放行、旧默认名变成未知", async () => {
    const cfg = makeConfig({ search: { reverse_image: { enabled: false, category: "image_search" } } });
    const ok = await createSearchService(cfg, domainFilter, silentLogger).search({
      query: "",
      categories: "image_search",
    });
    expect(ok.ok).toBe(true);
    expect(ok.text).not.toContain("未被 searxng 声明");

    const bad = await createSearchService(cfg, domainFilter, silentLogger).search({
      query: "",
      categories: "search_by_image",
    });
    expect(bad.ok).toBe(true);
    expect(bad.text).toContain("search_by_image");
    expect(bad.text).toContain("未被 searxng 声明");
  });
});

describe("/config 取不到时回退旧行为", () => {
  it("配置失败 → 不因校验报错，显式参数照常转发", async () => {
    configStatus = 500;
    searchCalls = [];
    try {
      const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
      const r = await svc.search({ query: "config-down", engines: "google", categories: "bogus" });
      expect(r.ok).toBe(true);
      expect(r.text).toContain("Hit");
      expect(searchCalls).toEqual([{ engines: "google", categories: "bogus" }]);
    } finally {
      configStatus = 200;
    }
  });
});

describe("0 结果 + 显式过滤的提示", () => {
  it("显式 engines/categories 且 0 结果 → 文末追加过滤提示", async () => {
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "empty", engines: "zhihu", categories: "general" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("没有找到结果");
    expect(r.text).toContain("注：已按 engines=zhihu / categories=general 过滤");
    expect(r.text).toContain("0 结果可能是该来源未启用或无匹配");
  });

  it("0 结果但未显式过滤 → 不追加提示（旧文案逐字不变）", async () => {
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "empty" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("没有找到结果");
    expect(r.text).not.toContain("注：已按");
  });
});

describe("网关侧搜索源失败的错误码", () => {
  function providerWith(kind: "auth" | "timeout" | "network", message: string): EngineProvider {
    return {
      ...fakeWeiboProvider,
      id: `gateway.search:fake-${kind}`,
      name: `fake-${kind}`,
      displayName: "FakeWeibo",
      authHint: kind === "auth" ? "在 Chrome 登录 weibo.com 后重试。" : undefined,
      runtime: {
        kind: "search",
        plan: () => ({ hot: false }),
        search: async () => ({ ok: false, error: { kind, message }, latencyMs: 1 }),
      },
    };
  }

  it("auth → SEARCH_AUTH_REQUIRED，且保留原始信息与处理提示", async () => {
    setExternalEngineProviders([providerWith("auth", "weibo post 失败：AUTH_REQUIRED")]);
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "未登录", categories: "weibo" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SEARCH_AUTH_REQUIRED");
    expect(r.text).toContain("[SEARCH_AUTH_REQUIRED]");
    expect(r.text).toContain("AUTH_REQUIRED");
    expect(r.text).toContain("处理：在 Chrome 登录 weibo.com 后重试。");
  });

  it("timeout 仍映射为 SEARCH_TIMEOUT", async () => {
    setExternalEngineProviders([providerWith("timeout", "命令超时")]);
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "超时", categories: "weibo" });
    expect(r.code).toBe("SEARCH_TIMEOUT");
    expect(r.text).toContain("[SEARCH_TIMEOUT]");
  });

  it("network 仍映射为 SEARCH_UPSTREAM", async () => {
    setExternalEngineProviders([providerWith("network", "连接失败")]);
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "断网", categories: "weibo" });
    expect(r.code).toBe("SEARCH_UPSTREAM");
  });
});
