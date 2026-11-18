import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchDeepSeekHarness,
  searchDeepSeekRaw,
  type DeepSeekHarnessOptions,
  type DeepSeekRawOptions,
} from "../src/search/deepseek.js";

/** 记录一次 fetch 调用（请求体已解析为对象）。 */
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 用 vi.stubGlobal 覆盖 fetch，并记录 URL / headers / body。 */
function stubFetch(responder: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const call: FetchCall = { url, headers, body };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

function stubReject(error: Error): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw error;
    }),
  );
}

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

function rawOptions(overrides: Partial<DeepSeekRawOptions> = {}): DeepSeekRawOptions {
  return {
    baseUrl: "https://api.deepseek.test/v1/tools",
    apiKey: "test-key",
    timeoutMs: 1000,
    limit: 10,
    needContent: false,
    localization: "",
    ...overrides,
  };
}

function harnessOptions(overrides: Partial<DeepSeekHarnessOptions> = {}): DeepSeekHarnessOptions {
  return {
    baseUrl: "https://api.deepseek.test/anthropic/v1",
    apiKey: "test-key",
    timeoutMs: 1000,
    limit: 10,
    model: "deepseek-flash",
    maxTokens: 1024,
    apiVersion: "2023-06-01",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("searchDeepSeekRaw", () => {
  it("映射字段：summary 优先、score=rerank_score/3、标题回退、保留官方字段", async () => {
    stubFetch(() =>
      jsonResponse({
        results: [
          { url: "https://low.example/a", title: "Low", rerank_score: 0.3 },
          {
            url: "https://high.example/b",
            title: "High",
            summary: "summary text",
            snippet: "snippet text",
            content: "content text",
            rerank_score: 2.4,
            date: "2024-01-02",
            site_name: "HighSite",
            site_icon: "https://high.example/icon.png",
            authority: 0.7,
          },
          {
            url: "https://mid.example/c",
            title: null,
            site_name: "MidSite",
            snippet: "snippet only",
            content: "content fallback",
            rerank_score: 1.5,
          },
          {
            url: "https://hostfallback.example/d",
            content: "body text",
          },
          // 空 URL：跳过
          { url: "", title: "No URL", rerank_score: 3 },
        ],
      }),
    );

    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.results.map((r) => r.url)).toEqual([
      "https://high.example/b",
      "https://mid.example/c",
      "https://hostfallback.example/d",
      "https://low.example/a",
    ]);

    const [high, mid, hostFallback, low] = res.results;
    expect(high.title).toBe("High");
    expect(high.content).toBe("summary text");
    expect(high.score).toBeCloseTo(0.8, 5);
    expect(high.publishedDate).toBe("2024-01-02");
    expect(high.engine).toBe("deepseek");
    expect(high.category).toBe("general");
    // 官方字段透传
    expect(high.site_name).toBe("HighSite");
    expect(high.site_icon).toBe("https://high.example/icon.png");
    expect(high.authority).toBe(0.7);
    expect(high.rerank_score).toBe(2.4);

    // title 为空 → site_name
    expect(mid.title).toBe("MidSite");
    expect(mid.content).toBe("snippet only");
    expect(mid.score).toBeCloseTo(0.5, 5);

    // 无 title / site_name → URL host
    expect(hostFallback.title).toBe("hostfallback.example");
    expect(hostFallback.content).toBe("body text");
    // rerank_score 缺失 → 0.5
    expect(hostFallback.score).toBe(0.5);

    expect(low.content).toBe("");
    expect(low.score).toBeCloseTo(0.1, 5);
  });

  it("need_content=true 时优先正文 content", async () => {
    stubFetch(() =>
      jsonResponse({
        results: [
          {
            url: "https://content.example/a",
            title: "Content",
            summary: "summary text",
            snippet: "snippet text",
            content: "full content text",
            rerank_score: 2.4,
          },
        ],
      }),
    );

    const res = await searchDeepSeekRaw("q", rawOptions({ needContent: true }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results[0].content).toBe("full content text");
  });

  it("空 results 返回 ok:true 与空数组", async () => {
    stubFetch(() => jsonResponse({ results: [] }));
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results).toEqual([]);
  });

  it("minScore 按 rerank_score/3 在源内过滤", async () => {
    stubFetch(() =>
      jsonResponse({
        results: [
          { url: "https://keep.example/a", title: "Keep", rerank_score: 2.4 },
          { url: "https://drop.example/b", title: "Drop", rerank_score: 0.6 },
        ],
      }),
    );
    const res = await searchDeepSeekRaw("q", rawOptions({ minScore: 0.5 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results.map((r) => r.url)).toEqual(["https://keep.example/a"]);
  });

  it("query 按码点截断到 128 字符", async () => {
    const calls = stubFetch(() => jsonResponse({ results: [] }));
    await searchDeepSeekRaw("😀".repeat(200), rawOptions());
    expect(Array.from(calls[0].body.query as string)).toHaveLength(128);
  });

  it("请求 URL / headers / body：count 上限 50、最少 1、localization 可选", async () => {
    const calls = stubFetch(() => jsonResponse({ results: [] }));

    await searchDeepSeekRaw("hello", rawOptions({ limit: 100, needContent: true, localization: "zh-CN" }));
    expect(calls[0].url).toBe("https://api.deepseek.test/v1/tools/search");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers.Accept).toBe("application/json");
    expect(calls[0].body).toEqual({
      query: "hello",
      count: 50,
      need_content: true,
      localization: "zh-CN",
    });

    await searchDeepSeekRaw("x", rawOptions({ limit: 0 }));
    expect(calls[1].body.count).toBe(1);
    expect(calls[1].body).not.toHaveProperty("localization");
  });

  it("HTTP 401 / 403 → auth", async () => {
    for (const status of [401, 403]) {
      stubFetch(() => jsonResponse({ error: { message: "denied" } }, status));
      const res = await searchDeepSeekRaw("q", rawOptions());
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.kind).toBe("auth");
    }
  });

  it("HTTP 402 → api 且提示余额不足", async () => {
    stubFetch(() => jsonResponse({ error: { message: "insufficient balance" } }, 402));
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("余额不足");
  });

  it("HTTP 429 → api 且提示限流", async () => {
    stubFetch(() => jsonResponse({ error: { message: "rate limit" } }, 429));
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("限流");
  });

  it("HTTP 500 → api 且带出响应 error.message", async () => {
    stubFetch(() => jsonResponse({ error: { message: "server exploded" } }, 500));
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("500");
    expect(res.error.message).toContain("server exploded");
  });

  it("非 JSON → invalid", async () => {
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("invalid");
  });

  it("TimeoutError → timeout", async () => {
    stubReject(timeoutError());
    const res = await searchDeepSeekRaw("q", rawOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("timeout");
  });
});

describe("searchDeepSeekHarness", () => {
  it("请求 URL / headers / body：Messages + deepseek_web_search + thinking 关闭", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ content: [{ type: "web_search_tool_result", content: [] }] }),
    );

    await searchDeepSeekHarness("hello world", harnessOptions());

    expect(calls[0].url).toBe("https://api.deepseek.test/anthropic/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("test-key");
    expect(calls[0].headers.authorization).toBe("Bearer test-key");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Perform a web search for the query: hello world" }],
      tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
      thinking: { type: "disabled" },
    });
    expect(calls[0].body).not.toHaveProperty("max_uses");
    expect(JSON.stringify(calls[0].body)).not.toContain("max_uses");
  });

  it("解析 web_search_result：字段映射、标题回退、多块按 URL 去重、citation 补 content", async () => {
    stubFetch(() =>
      jsonResponse({
        content: [
          {
            type: "text",
            text: "引用若干来源",
            citations: [
              // citation 的 URL 带跟踪参数：应按规范化 URL 匹配补全
              { url: "https://cited.example/a?utm_source=chat", cited_text: "cited text a" },
            ],
          },
          {
            type: "web_search_tool_result",
            content: [
              {
                type: "web_search_result",
                url: "https://harness.example/one",
                title: "Harness One",
                snippet: "snip one",
                page_age: "2024-03-04",
              },
              {
                type: "web_search_result",
                url: "https://cited.example/a",
                title: "",
                site_name: "Cited Site",
              },
              { type: "web_search_result", url: "", title: "No URL" },
            ],
          },
          {
            type: "web_search_tool_result",
            content: [
              // 同一 URL 的 utm 变体：规范化后应被去重
              {
                type: "web_search_result",
                url: "https://harness.example/one?utm_source=dup",
                title: "Duplicate Should Vanish",
              },
              {
                type: "web_search_result",
                url: "https://harness.example/two",
                title: null,
              },
            ],
          },
        ],
      }),
    );

    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.results.map((r) => r.url)).toEqual([
      "https://harness.example/one",
      "https://cited.example/a",
      "https://harness.example/two",
    ]);

    const [one, cited, two] = res.results;
    expect(one.title).toBe("Harness One");
    expect(one.content).toBe("snip one");
    expect(one.publishedDate).toBe("2024-03-04");
    expect(one.engine).toBe("deepseek_harness");
    expect(one.category).toBe("general");
    // harness 无原始分：不设置 score
    expect(one.score).toBeUndefined();

    // 标题为空 → site_name；snippet 缺失 → citations[].cited_text
    expect(cited.title).toBe("Cited Site");
    expect(cited.content).toBe("cited text a");
    expect(cited.score).toBeUndefined();

    // 无 title / site_name → URL host；无 snippet / citation → 空串
    expect(two.title).toBe("harness.example");
    expect(two.content).toBe("");
    expect(two.score).toBeUndefined();
  });

  it("没有任何 web_search_tool_result 块 → api", async () => {
    stubFetch(() => jsonResponse({ content: [{ type: "text", text: "直接回答" }] }));
    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("web_search_tool_result");
  });

  it("web_search_tool_result_error → api", async () => {
    stubFetch(() =>
      jsonResponse({
        content: [
          {
            type: "web_search_tool_result",
            content: [{ type: "web_search_tool_result_error", error_code: "unavailable" }],
          },
        ],
      }),
    );
    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("unavailable");
  });

  it("stop_reason=refusal → api", async () => {
    stubFetch(() => jsonResponse({ content: [], stop_reason: "refusal" }));
    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("refusal");
  });

  it("HTTP 200 但 body 是 {type:'error'} → api", async () => {
    stubFetch(() => jsonResponse({ type: "error", error: { message: "model overloaded" } }));
    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("api");
    expect(res.error.message).toContain("model overloaded");
  });

  it("HTTP 401 → auth", async () => {
    stubFetch(() => jsonResponse({ error: { message: "unauthorized" } }, 401));
    const res = await searchDeepSeekHarness("q", harnessOptions());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("auth");
  });
});
