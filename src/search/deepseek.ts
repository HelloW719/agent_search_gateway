/**
 * DeepSeek 通用搜索上游客户端。
 *
 * 两种模式：
 * - `raw`：POST /search，官方 rerank_score 只用于源内排序 / min_score；
 * - `harness`：模拟 DeepSeek Harness 的 Messages + `deepseek_web_search` 工具，
 *   无原始分，结果按返回顺序交给融合层做名次归一化。
 *
 * 所有失败都返回结构化错误，不抛裸异常。
 */

import type { GatewaySearchError, GatewaySearchResult } from "../engines/provider.js";
import { normalizeUrlKey } from "./clean.js";
import type { SearxngResult } from "./searxng.js";

export interface DeepSeekRawOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  limit: number;
  needContent: boolean;
  localization: string;
  minScore?: number;
}

export interface DeepSeekHarnessOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  limit: number;
  model: string;
  maxTokens: number;
  apiVersion: string;
}

interface RawItem {
  rerank_score?: number;
  title?: string | null;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  site_icon?: string | null;
  date?: string | null;
  authority?: number;
}

interface RawResponse {
  results?: RawItem[];
  [key: string]: unknown;
}

interface HarnessResponse {
  content?: unknown[];
  stop_reason?: string | null;
  [key: string]: unknown;
}

type JsonObject = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function truncateChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function fail(kind: GatewaySearchError["kind"], message: string, started: number): GatewaySearchResult {
  return { ok: false, error: { kind, message }, latencyMs: Date.now() - started };
}

/** 上游把错误塞在 200 响应里（Anthropic 风格）。 */
function isErrorBody(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as JsonObject).type === "error";
}

function errorBodyMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as JsonObject;
    const err = obj.error;
    if (typeof err === "string" && err.length > 0) return `DeepSeek 返回错误：${err}`;
    if (err && typeof err === "object") {
      const msg = (err as JsonObject).message;
      if (typeof msg === "string" && msg.length > 0) return `DeepSeek 返回错误：${msg}`;
    }
    const msg = obj.message;
    if (typeof msg === "string" && msg.length > 0) return `DeepSeek 返回错误：${msg}`;
  }
  return "DeepSeek 返回错误响应";
}

/** 尽量从错误响应 body 里取 `error.message`（兼容纯文本）。 */
async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object") {
        const obj = data as JsonObject;
        const err = obj.error;
        if (typeof err === "string" && err.length > 0) return err;
        if (err && typeof err === "object") {
          const msg = (err as JsonObject).message;
          if (typeof msg === "string" && msg.length > 0) return msg;
        }
        const msg = obj.message;
        if (typeof msg === "string" && msg.length > 0) return msg;
      }
    } catch {
      /* 非 JSON：退回原文 */
    }
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return undefined;
  }
}

async function httpFailure(res: Response, started: number): Promise<GatewaySearchResult> {
  if (res.status === 401 || res.status === 403) {
    return fail("auth", `DeepSeek 鉴权失败（HTTP ${res.status}）`, started);
  }
  if (res.status === 402) {
    return fail("api", `DeepSeek 余额不足（HTTP 402）`, started);
  }
  if (res.status === 429) {
    return fail("api", `DeepSeek 请求限流（HTTP 429）`, started);
  }
  const detail = await readErrorMessage(res);
  const suffix = detail ? `：${detail}` : "";
  return fail("api", `DeepSeek HTTP ${res.status}${suffix}`, started);
}

function thrownFailure(err: unknown, timeoutMs: number, started: number): GatewaySearchResult {
  const rawName = (err as { name?: unknown } | undefined)?.name;
  const name = typeof rawName === "string" ? rawName : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return fail("timeout", `DeepSeek 请求超时（>${timeoutMs}ms）`, started);
  }
  return fail("network", err instanceof Error ? err.message : String(err), started);
}

function mapRawItem(item: RawItem, needContent: boolean): SearxngResult | undefined {
  const url = optionalString(item.url);
  if (!url) return undefined;

  const siteName = optionalString(item.site_name);
  const title = optionalString(item.title) ?? siteName ?? hostnameOf(url) ?? "";
  // 默认用 summary（面向模型的定向摘要）；显式 need_content 时优先正文。
  const content = needContent
    ? optionalString(item.content) ??
      optionalString(item.summary) ??
      optionalString(item.snippet) ??
      ""
    : optionalString(item.summary) ??
      optionalString(item.snippet) ??
      optionalString(item.content) ??
      "";
  const rawScore =
    typeof item.rerank_score === "number" && Number.isFinite(item.rerank_score)
      ? item.rerank_score
      : undefined;
  const score = rawScore === undefined ? 0.5 : clamp(rawScore / 3, 0, 1);

  const result: SearxngResult = {
    url,
    title,
    content,
    engine: "deepseek",
    category: "general",
    score,
  };
  if (typeof item.date === "string") result.publishedDate = item.date;
  if (item.site_name !== undefined) result.site_name = item.site_name;
  if (item.site_icon !== undefined) result.site_icon = item.site_icon;
  if (item.authority !== undefined) result.authority = item.authority;
  if (item.rerank_score !== undefined) result.rerank_score = item.rerank_score;
  return result;
}

/** 从所有 text 块的 citations 建 `url -> cited_text`，首次出现优先。 */
function collectCitations(content: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const obj = block as JsonObject;
    if (obj.type !== "text" || !Array.isArray(obj.citations)) continue;
    for (const citation of obj.citations) {
      if (!citation || typeof citation !== "object") continue;
      const item = citation as JsonObject;
      const url = optionalString(item.url);
      const text = optionalString(item.cited_text);
      if (!url || !text) continue;
      if (!map.has(url)) map.set(url, text);
      const key = normalizeUrlKey(url);
      if (!map.has(key)) map.set(key, text);
    }
  }
  return map;
}

function mapHarnessResult(
  item: JsonObject,
  citedText: Map<string, string>,
): SearxngResult | undefined {
  const url = optionalString(item.url);
  if (!url) return undefined;

  const siteName = optionalString(item.site_name);
  const title = optionalString(item.title) ?? siteName ?? hostnameOf(url) ?? "";
  const content = optionalString(item.snippet) ?? citedText.get(url) ?? citedText.get(normalizeUrlKey(url)) ?? "";
  const result: SearxngResult = {
    url,
    title,
    content,
    engine: "deepseek_harness",
    category: "general",
  };
  if (typeof item.page_age === "string") result.publishedDate = item.page_age;
  return result;
}

/** 调用 DeepSeek Search API（raw 模式）。 */
export async function searchDeepSeekRaw(
  query: string,
  options: DeepSeekRawOptions,
): Promise<GatewaySearchResult> {
  const started = Date.now();
  const payload: Record<string, unknown> = {
    query: truncateChars(query, 128),
    count: Math.max(1, Math.min(options.limit, 50)),
    need_content: options.needContent,
  };
  if (options.localization.length > 0) payload.localization = options.localization;

  try {
    const res = await fetch(joinUrl(options.baseUrl, "/search"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!res.ok) return await httpFailure(res, started);

    let data: RawResponse;
    try {
      data = (await res.json()) as RawResponse;
    } catch {
      return fail("invalid", "DeepSeek 返回非 JSON", started);
    }
    if (isErrorBody(data)) return fail("api", errorBodyMessage(data), started);

    const items = Array.isArray(data.results) ? data.results : [];
    const mapped: SearxngResult[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const result = mapRawItem(item, options.needContent);
      if (result) mapped.push(result);
    }

    // 稳定降序：Array.prototype.sort 在现代运行时保证稳定。
    mapped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    const filtered =
      options.minScore === undefined
        ? mapped
        : mapped.filter((result) => (result.score ?? 0) >= options.minScore!);

    return {
      ok: true,
      results: filtered.slice(0, Math.max(0, options.limit)),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return thrownFailure(err, options.timeoutMs, started);
  }
}

/** 调用 DeepSeek Harness Messages + `deepseek_web_search`（harness 模式）。 */
export async function searchDeepSeekHarness(
  query: string,
  options: DeepSeekHarnessOptions,
): Promise<GatewaySearchResult> {
  const started = Date.now();
  const payload = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
    tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
    thinking: { type: "disabled" },
  };

  try {
    const res = await fetch(joinUrl(options.baseUrl, "/messages"), {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        authorization: `Bearer ${options.apiKey}`,
        "anthropic-version": options.apiVersion,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!res.ok) return await httpFailure(res, started);

    let data: HarnessResponse;
    try {
      data = (await res.json()) as HarnessResponse;
    } catch {
      return fail("invalid", "DeepSeek 返回非 JSON", started);
    }
    if (isErrorBody(data)) return fail("api", errorBodyMessage(data), started);
    if (data.stop_reason === "refusal") {
      return fail("api", "DeepSeek 拒绝执行搜索（stop_reason: refusal）", started);
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const citedText = collectCitations(blocks);
    const seen = new Set<string>();
    const results: SearxngResult[] = [];
    let sawSearchResultBlock = false;
    let searchErrorMessage: string | undefined;

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const blockObj = block as JsonObject;
      if (blockObj.type !== "web_search_tool_result") continue;
      sawSearchResultBlock = true;
      if (!Array.isArray(blockObj.content)) {
        const error = blockObj.content as JsonObject | undefined;
        if (error && error.type === "web_search_tool_result_error") {
          searchErrorMessage = optionalString(error.error_code) ?? "搜索失败";
        }
        continue;
      }

      for (const rawItem of blockObj.content) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as JsonObject;
        if (item.type === "web_search_tool_result_error") {
          searchErrorMessage = optionalString(item.error_code) ?? "搜索失败";
          continue;
        }
        if (item.type !== "web_search_result") continue;
        const url = optionalString(item.url);
        if (!url) continue;
        const key = normalizeUrlKey(url);
        if (seen.has(key)) continue;
        seen.add(key);
        const result = mapHarnessResult(item, citedText);
        if (result) results.push(result);
      }
    }

    if (results.length === 0 && searchErrorMessage) {
      return fail("api", `DeepSeek 搜索失败：${searchErrorMessage}`, started);
    }
    if (!sawSearchResultBlock) {
      return fail("api", "DeepSeek 未触发服务端搜索（没有 web_search_tool_result）", started);
    }

    return {
      ok: true,
      results: results.slice(0, Math.max(0, options.limit)),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return thrownFailure(err, options.timeoutMs, started);
  }
}
