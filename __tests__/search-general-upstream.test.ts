import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import { createSearchService, type SearchMetrics, type SearchParams, type SearchSettingsDeps } from "../src/search/service.js";
import type { Settings } from "../src/settings/index.js";
import { deepMerge, makeSecrets, makeSettings, searchServiceDeps, type DeepPartial } from "./helpers/settings.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

const domainFilter: DomainFilter = { enabled: false, blocked: new Set(), allowlist: new Set(), count: 0 };

const DEEPSEEK_ID = "gateway.upstream:deepseek";

interface MockState {
  searxngResults: Array<Record<string, unknown>>;
  searxngStatus: number;
  rawResults: Array<Record<string, unknown>>;
  rawStatus: number;
  rawDelayMs: number;
  harnessContent: unknown[];
  harnessStatus: number;
  searxngRequests: number;
  rawRequests: number;
  harnessRequests: number;
  configRequests: number;
  lastSearxngQuery?: string;
  /** 两边请求到达 mock 的时间，用于确认并发发起。 */
  searxngStartedAt?: number;
  rawStartedAt?: number;
  lastRawBody?: Record<string, unknown>;
  lastRawHeaders?: IncomingMessage["headers"];
  lastHarnessBody?: Record<string, unknown>;
  lastHarnessHeaders?: IncomingMessage["headers"];
}

const mock: MockState = {
  searxngResults: [],
  searxngStatus: 200,
  rawResults: [],
  rawStatus: 200,
  rawDelayMs: 0,
  harnessContent: [],
  harnessStatus: 200,
  searxngRequests: 0,
  rawRequests: 0,
  harnessRequests: 0,
  configRequests: 0,
};

/** 每个测试独立清理 mock 状态（服务实例的缓存另行用新 service 隔离）。 */
function resetMock(): void {
  mock.searxngResults = [];
  mock.searxngStatus = 200;
  mock.rawResults = [];
  mock.rawStatus = 200;
  mock.rawDelayMs = 0;
  mock.harnessContent = [];
  mock.harnessStatus = 200;
  mock.searxngRequests = 0;
  mock.rawRequests = 0;
  mock.harnessRequests = 0;
  mock.configRequests = 0;
  mock.lastSearxngQuery = undefined;
  mock.searxngStartedAt = undefined;
  mock.rawStartedAt = undefined;
  mock.lastRawBody = undefined;
  mock.lastRawHeaders = undefined;
  mock.lastHarnessBody = undefined;
  mock.lastHarnessHeaders = undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function searchResult(
  url: string,
  title: string,
  options: { content?: string; score?: number } = {},
): Record<string, unknown> {
  return {
    url,
    title,
    content: options.content ?? `${title} content`,
    engine: "mock",
    score: options.score ?? 0.5,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/config") {
    mock.configRequests++;
    sendJson(res, {
      engines: [{ name: "mock", enabled: true }],
      categories: ["general"],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/search") {
    mock.searxngRequests++;
    mock.searxngStartedAt = Date.now();
    mock.lastSearxngQuery = url.searchParams.get("q") ?? "";
    if (mock.searxngStatus !== 200) {
      res.statusCode = mock.searxngStatus;
      res.end("searxng mock failure");
      return;
    }
    sendJson(res, { query: mock.lastSearxngQuery, results: mock.searxngResults });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tools/search") {
    mock.rawRequests++;
    mock.rawStartedAt = Date.now();
    mock.lastRawBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
    mock.lastRawHeaders = req.headers;
    if (mock.rawDelayMs > 0) await delay(mock.rawDelayMs);
    if (mock.rawStatus !== 200) {
      sendJson(res, { error: { message: "raw upstream boom" } }, mock.rawStatus);
      return;
    }
    sendJson(res, { results: mock.rawResults });
    return;
  }

  if (req.method === "POST" && url.pathname === "/anthropic/v1/messages") {
    mock.harnessRequests++;
    mock.lastHarnessBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
    mock.lastHarnessHeaders = req.headers;
    if (mock.harnessStatus !== 200) {
      sendJson(res, { type: "error", error: { message: "harness upstream boom" } }, mock.harnessStatus);
      return;
    }
    sendJson(res, { content: mock.harnessContent });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
}

let mockServer: ReturnType<typeof createHttpServer>;
let baseUrl = "";

beforeAll(async () => {
  mockServer = createHttpServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  mockServer.close();
});

beforeEach(() => {
  resetMock();
});

function makeDeps(overrides: DeepPartial<Settings> = {}): SearchSettingsDeps {
  const base: DeepPartial<Settings> = {
    searxng: { url: baseUrl, timeout_ms: 3000 },
    search: {
      quota_enabled: false,
      deepseek: {
        enabled: true,
        mode: "raw",
        limit: 10,
        api: { base_url: `${baseUrl}/v1/tools`, timeout_ms: 3000 },
        harness: { base_url: `${baseUrl}/anthropic/v1`, timeout_ms: 3000 },
      },
    },
    rerank: { enabled: false, engine_boost: {} },
  };
  return searchServiceDeps(
    makeSettings(deepMerge(base, overrides)),
    makeSecrets({ search: { deepseek: { api_key: "test-key" } } }),
  );
}

function harnessBlock(results: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: "web_search_tool_result", content: results };
}

function harnessResult(
  url: string,
  title: string,
  options: { snippet?: string; page_age?: string } = {},
): Record<string, unknown> {
  return {
    type: "web_search_result",
    url,
    title,
    snippet: options.snippet,
    page_age: options.page_age,
  };
}

/** 找到包含指定文本的渲染行（用于断言该条目的 score 标注与相对顺序）。 */
function lineWith(text: string, needle: string): string {
  const line = text.split("\n").find((l) => l.includes(needle));
  expect(line).toBeDefined();
  return line ?? "";
}

describe("searxng + DeepSeek 通用上游融合", () => {
  it("general 查询并发调用 searxng 与 DeepSeek，输出同时包含两边结果", async () => {
    mock.searxngResults = [
      searchResult("https://searxng.example/1", "Searxng One", { score: 0.9 }),
      searchResult("https://searxng.example/2", "Searxng Two", { score: 0.5 }),
    ];
    mock.rawResults = [
      { url: "https://deepseek.example/1", title: "DeepSeek One", summary: "d1", rerank_score: 2.4 },
      { url: "https://deepseek.example/2", title: "DeepSeek Two", summary: "d2", rerank_score: 1.5 },
    ];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "concurrent" });

    expect(r.ok).toBe(true);
    expect(mock.searxngRequests).toBe(1);
    expect(mock.rawRequests).toBe(1);
    expect(mock.configRequests).toBe(1);
    // 两边是并发发起的（顺序等待会串行到毫秒级之后；这里只做宽松窗口断言）
    expect(mock.searxngStartedAt).toBeDefined();
    expect(mock.rawStartedAt).toBeDefined();
    expect(Math.abs((mock.searxngStartedAt ?? 0) - (mock.rawStartedAt ?? 0))).toBeLessThan(200);
    expect(mock.lastSearxngQuery).toBe("concurrent");
    expect(mock.lastRawBody).toMatchObject({ query: "concurrent", count: 10, need_content: false });
    expect(mock.lastRawHeaders?.authorization).toBe("Bearer test-key");
    expect(r.text).toContain("Searxng One");
    expect(r.text).toContain("Searxng Two");
    expect(r.text).toContain("DeepSeek One");
    expect(r.text).toContain("DeepSeek Two");
  });

  it("两个源的第一名都得到名次分 1.00", async () => {
    mock.searxngResults = [
      searchResult("https://searxng.example/a", "Searxng First", { score: 0.9 }),
      searchResult("https://searxng.example/b", "Searxng Second", { score: 0.4 }),
    ];
    mock.rawResults = [
      { url: "https://deepseek.example/a", title: "DeepSeek First", summary: "d1", rerank_score: 2.7 },
      { url: "https://deepseek.example/b", title: "DeepSeek Second", summary: "d2", rerank_score: 1.2 },
    ];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "both first" });
    expect(r.ok).toBe(true);

    expect(lineWith(r.text, "Searxng First")).toContain("score 1.00");
    expect(lineWith(r.text, "DeepSeek First")).toContain("score 1.00");
    // 两个源的第二名都是 1/2
    expect(lineWith(r.text, "Searxng Second")).toContain("score 0.50");
    expect(lineWith(r.text, "DeepSeek Second")).toContain("score 0.50");
  });

  it("重复 URL 只出现一次，engines 取并集且空字段互补", async () => {
    mock.searxngResults = [
      searchResult("https://dup.example/page?utm_source=searxng", "Dup Searxng", { content: "", score: 0.9 }),
    ];
    mock.rawResults = [
      { url: "https://dup.example/page", title: "Dup DeepSeek", summary: "deepseek content", rerank_score: 2.4 },
    ];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "duplicate" });
    expect(r.ok).toBe(true);

    // 只渲染一次（规范化 URL 去重）
    expect((r.text.match(/dup\.example\/page/g) ?? []).length).toBe(1);
    // engines 并集（searxng 的 mock + deepseek）
    const dupLine = lineWith(r.text, "Dup Searxng");
    expect(dupLine.includes("mock/deepseek") || dupLine.includes("deepseek/mock")).toBe(true);
    // 空 content 由另一源补齐
    expect(r.text).toContain("deepseek content");
  });

  it("harness 结果（无 score）按名次归一化，不被垫底或误杀", async () => {
    mock.searxngResults = [
      searchResult("https://searxng.example/a", "Searxng First", { score: 0.9 }),
      searchResult("https://searxng.example/b", "Searxng Second", { score: 0.4 }),
    ];
    mock.harnessContent = [
      harnessBlock([
        harnessResult("https://harness.example/top", "Harness Top", { snippet: "h1" }),
        harnessResult("https://harness.example/next", "Harness Next", { snippet: "h2" }),
      ]),
    ];

    const deps = makeDeps({ search: { deepseek: { mode: "harness" } } });
    const svc = createSearchService(deps, domainFilter, silentLogger);
    const r = await svc.search({ query: "harness rank" });
    expect(r.ok).toBe(true);

    // harness 请求走 Messages 端点
    expect(mock.harnessRequests).toBe(1);
    expect(mock.rawRequests).toBe(0);

    // 第一名拿到 1.00，且排在 searxng 第二名（0.50）之前
    expect(lineWith(r.text, "Harness Top")).toContain("score 1.00");
    expect(r.text.indexOf("Harness Top")).toBeLessThan(r.text.indexOf("Searxng Second"));
  });

  it("min_score：raw 在源内过滤、searxng 正常过滤、harness 不过滤", async () => {
    mock.searxngResults = [
      searchResult("https://searxng.example/keep", "Searxng Kept", { score: 0.9 }),
      searchResult("https://searxng.example/drop", "Searxng Dropped", { score: 0.3 }),
    ];
    mock.rawResults = [
      { url: "https://deepseek.example/keep", title: "Raw Kept", summary: "k", rerank_score: 2.4 },
      { url: "https://deepseek.example/drop", title: "Raw Dropped", summary: "d", rerank_score: 0.6 },
    ];

    const rawService = createSearchService(makeDeps(), domainFilter, silentLogger);
    const rawOutcome = await rawService.search({ query: "min score raw", minScore: 0.5 });
    expect(rawOutcome.ok).toBe(true);
    expect(rawOutcome.text).toContain("Searxng Kept");
    expect(rawOutcome.text).not.toContain("Searxng Dropped");
    expect(rawOutcome.text).toContain("Raw Kept");
    expect(rawOutcome.text).not.toContain("Raw Dropped");

    // harness 无原始分：不参与 min_score 过滤
    resetMock();
    mock.searxngResults = [searchResult("https://searxng.example/keep", "Searxng Kept", { score: 0.9 })];
    mock.harnessContent = [harnessBlock([harnessResult("https://harness.example/low", "Harness Unscored")])];
    const harnessService = createSearchService(
      makeDeps({ search: { deepseek: { mode: "harness" } } }),
      domainFilter,
      silentLogger,
    );
    const harnessOutcome = await harnessService.search({ query: "min score harness", minScore: 0.5 });
    expect(harnessOutcome.ok).toBe(true);
    expect(harnessOutcome.text).toContain("Harness Unscored");
  });

  it("engine_boost 影响最终顺序（deepseek: 2 时 DeepSeek 条目前置）", async () => {
    mock.searxngResults = [
      searchResult("https://searxng.example/first", "Searxng First", { score: 0.9 }),
      searchResult("https://searxng.example/second", "Searxng Second", { score: 0.5 }),
    ];
    mock.rawResults = [
      { url: "https://deepseek.example/first", title: "DeepSeek First", summary: "d", rerank_score: 2.4 },
      { url: "https://deepseek.example/second", title: "DeepSeek Second", summary: "d", rerank_score: 1.2 },
    ];

    const deps = makeDeps({ rerank: { enabled: false, engine_boost: { deepseek: 2 } } });
    const svc = createSearchService(deps, domainFilter, silentLogger);
    const r = await svc.search({ query: "boosted" });
    expect(r.ok).toBe(true);

    // 两边第一名原始名次分都是 1.0；deepseek ×2 → 排到最前
    expect(r.text.indexOf("DeepSeek First")).toBeLessThan(r.text.indexOf("Searxng First"));
  });

  it("DeepSeek HTTP 500 → searxng 结果正常 + 降级提示", async () => {
    mock.rawStatus = 500;
    mock.searxngResults = [searchResult("https://searxng.example/ok", "Searxng Survives", { score: 0.9 })];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "deepseek 500" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Searxng Survives");
    expect(r.text).toContain("DeepSeek 上游不可用");
    expect(r.text).toContain("以下结果不含 DeepSeek");
  });

  it("DeepSeek 超时 → searxng 结果正常 + timeout 提示", async () => {
    mock.rawDelayMs = 300;
    mock.searxngResults = [searchResult("https://searxng.example/ok", "Searxng Survives", { score: 0.9 })];

    const deps = makeDeps({ search: { deepseek: { api: { timeout_ms: 50 } } } });
    const svc = createSearchService(deps, domainFilter, silentLogger);
    const r = await svc.search({ query: "deepseek timeout" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Searxng Survives");
    expect(r.text).toContain("DeepSeek 上游不可用（timeout）");
  });

  it("searxng 失败但 DeepSeek 成功 → DeepSeek 结果 + 提示", async () => {
    mock.searxngStatus = 500;
    mock.rawResults = [
      { url: "https://deepseek.example/only", title: "DeepSeek Only", summary: "only", rerank_score: 2.4 },
    ];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "searxng down" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("DeepSeek Only");
    expect(r.text).toContain("searxng 未返回结果");
  });

  it("两边都失败 → ok:false，错误文本包含双方原因", async () => {
    mock.searxngStatus = 500;
    mock.rawStatus = 500;

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r = await svc.search({ query: "all down" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("搜索失败");
    expect(r.text).toContain("searxng");
    expect(r.text).toContain("DeepSeek");
  });
});

describe("DeepSeek 通用上游参与条件", () => {
  async function expectSkipped(params: SearchParams, overrides: DeepPartial<Settings> = {}): Promise<void> {
    resetMock();
    mock.searxngResults = [searchResult("https://searxng.example/only", "Searxng Only", { score: 0.9 })];
    const svc = createSearchService(makeDeps(overrides), domainFilter, silentLogger);
    const r = await svc.search(params);
    expect(r.ok).toBe(true);
    expect(mock.rawRequests).toBe(0);
    expect(mock.harnessRequests).toBe(0);
  }

  it("categories=news 不调用 DeepSeek", async () => {
    await expectSkipped({ query: "news", categories: "news" });
  });

  it("显式 engines=mock 不调用 DeepSeek", async () => {
    await expectSkipped({ query: "explicit", engines: "mock" });
  });

  it("空 query 不调用 DeepSeek", async () => {
    await expectSkipped({ query: "" });
  });

  it("search.deepseek.enabled=false 不调用 DeepSeek", async () => {
    await expectSkipped({ query: "disabled" }, { search: { deepseek: { enabled: false } } });
  });
});

describe("DeepSeek 通用上游缓存与指标", () => {
  it("同一查询第二次命中缓存：DeepSeek 只请求一次", async () => {
    mock.searxngResults = [searchResult("https://searxng.example/a", "Searxng Hit", { score: 0.9 })];
    mock.rawResults = [{ url: "https://deepseek.example/a", title: "DeepSeek Hit", summary: "d", rerank_score: 2.4 }];

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r1 = await svc.search({ query: "cache me" });
    const r2 = await svc.search({ query: "cache me" });
    expect(r1.ok && r1.cacheHit).toBe(false);
    expect(r2.ok && r2.cacheHit).toBe(true);
    expect(mock.rawRequests).toBe(1);
  });

  it("DeepSeek 失败时不写缓存：同一查询两次 → 请求两次", async () => {
    mock.searxngResults = [searchResult("https://searxng.example/a", "Searxng Hit", { score: 0.9 })];
    mock.rawStatus = 500;

    const svc = createSearchService(makeDeps(), domainFilter, silentLogger);
    const r1 = await svc.search({ query: "degraded cache" });
    const r2 = await svc.search({ query: "degraded cache" });
    expect(r1.ok && r1.cacheHit).toBe(false);
    expect(r2.ok && r2.cacheHit).toBe(false);
    expect(mock.rawRequests).toBe(2);
  });

  it("metrics 捕获 generalUpstreams（id / ok / results）", async () => {
    mock.searxngResults = [searchResult("https://searxng.example/a", "Searxng Hit", { score: 0.9 })];
    mock.rawResults = [
      { url: "https://deepseek.example/a", title: "DeepSeek A", summary: "a", rerank_score: 2.4 },
      { url: "https://deepseek.example/b", title: "DeepSeek B", summary: "b", rerank_score: 1.5 },
    ];

    const captured: SearchMetrics[] = [];
    const svc = createSearchService(makeDeps(), domainFilter, silentLogger, {
      metricsSink: (metrics) => captured.push(metrics),
    });
    await svc.search({ query: "metrics q" });

    expect(captured).toHaveLength(1);
    const upstreams = captured[0].generalUpstreams;
    expect(upstreams).toHaveLength(1);
    expect(upstreams?.[0]).toMatchObject({
      id: DEEPSEEK_ID,
      ok: true,
      results: 2,
    });
    expect(typeof upstreams?.[0].ms).toBe("number");
    expect(upstreams?.[0].error).toBeUndefined();
  });

  it("DeepSeek 关闭时输出不含 deepseek，行为与单上游一致", async () => {
    mock.searxngResults = [searchResult("https://searxng.example/only", "Searxng Only", { score: 0.9 })];

    const svc = createSearchService(
      makeDeps({ search: { deepseek: { enabled: false } } }),
      domainFilter,
      silentLogger,
    );
    const r = await svc.search({ query: "single upstream" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Searxng Only");
    expect(r.text.toLowerCase()).not.toContain("deepseek");
    expect(mock.rawRequests).toBe(0);
  });
});
