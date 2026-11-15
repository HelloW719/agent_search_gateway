import { createDocument, type DominoDocument, type DominoElement } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { countVisibleChars } from "./content.js";

/** 清理模式：移除的元素选择器 */
const CLEAN_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "footer",
  "aside",
  "form",
  "iframe",
  "[class*='advert']",
  "[class*='ad-']",
  "[class*='ads']",
  "[id*='advert']",
  "[id*='ad-']",
  "[id*='ads']",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='social-share']",
  "[class*='share-']",
  "[class*='related']",
  "[class*='recommend']",
  "[class*='sidebar']",
  "[class*='menu']",
  "[class*='breadcrumb']",
  "[class*='pagination']",
];

/**
 * 永远不会成为可见正文的节点：full 兜底时也要排除，否则纯 script 空壳
 * 会被当作“有正文”，破坏 JS 空壳判定。
 */
const NON_VISIBLE_SELECTORS = ["script", "style", "noscript"];

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 遍历 domino 的 NodeList（不可迭代，需索引访问） */
function each(list: { length: number }, fn: (el: DominoElement, i: number) => void): void {
  for (let i = 0; i < list.length; i++) {
    const el = (list as unknown as { [k: number]: DominoElement })[i];
    if (el) fn(el, i);
  }
}

/** html/body 及其等同节点绝不能被 clean 删除：删掉根节点会连带清空整篇正文。 */
function isRootElement(el: DominoElement, roots: DominoElement[]): boolean {
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "html" || tag === "body") return true;
  return roots.some((root) => root === el);
}

/**
 * clean 模式：只在 body 的后代里删噪音节点。
 *
 * 直接把选择器跑在整个 document 上会命中根节点自身——例如 Wikipedia 的
 * `<html class="… vector-feature-main-menu-pinned-disabled …">` 会命中
 * `[class*='menu']`，`remove()` 之后就只剩空文档。
 */
function removeNoiseElements(doc: DominoDocument): void {
  const body = doc.querySelector("body");
  const html = doc.querySelector("html");
  const roots = [html, body].filter((el): el is DominoElement => el !== null);

  for (const sel of CLEAN_SELECTORS) {
    // `body ${sel}`：匹配范围限定为 body 后代（不含 body 自身）。
    // 文档没有 body（异常片段）时退回全文档匹配，但仍受 isRootElement 保护。
    const scoped = body ? `body ${sel}` : sel;
    each(doc.querySelectorAll(scoped), (el) => {
      if (!isRootElement(el, roots)) el.remove();
    });
  }
}

/** 把相对 URL（href/src）转为绝对 URL，基于 baseUrl。 */
function absolutizeUrls(doc: DominoDocument, baseUrl: string): void {
  each(doc.querySelectorAll("[href]"), (el) => {
    const v = el.getAttribute("href");
    if (v) el.setAttribute("href", absoluteUrl(v, baseUrl));
  });
  each(doc.querySelectorAll("[src]"), (el) => {
    const v = el.getAttribute("src");
    if (v) el.setAttribute("src", absoluteUrl(v, baseUrl));
  });
}

function collapseBlankLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** data: URI 图片（尤其 base64）会把上下文撑满；可由调用方换成落盘链接，否则丢弃。 */
function rewriteInlineDataImages(
  doc: DominoDocument,
  resolveImage?: (src: string) => string | undefined,
): void {
  each(doc.querySelectorAll("img[src]"), (el) => {
    const src = el.getAttribute("src") ?? "";
    if (!/^data:/i.test(src)) return;
    const replacement = resolveImage?.(src);
    if (replacement) el.setAttribute("src", replacement);
    else el.remove();
  });
}

export interface HtmlToMdOptions {
  /** clean(去导航/广告) | full(保留完整结构) */
  structural: "clean" | "full";
  baseUrl: string;
  maxOutputChars: number;
  /**
   * 把 data: URI 图片转成可用链接（通常落盘后返回 `/files/<id>`）。
   * 返回 undefined 时丢弃该图片。
   */
  resolveImage?: (src: string) => string | undefined;
}

export interface HtmlToMdResult {
  markdown: string;
  title: string | undefined;
  /** 截断前的正文可见字符数（不含标题/图片/URL/标点），用于 JS 空壳判定。 */
  contentChars: number;
}

/**
 * 单次解析 + 转换：parse →（clean 去噪）→ 图片/URL 规整 → turndown → 折叠空白。
 * contentChars 在此处（截断前）统计。
 *
 * `stripNonVisible` 仅用于 full 兜底 pass：script/style/noscript 的文本不是正文，
 * 但 full 模式本身不删节点，所以由调用方按需开启。
 */
function renderMarkdown(
  html: string,
  structural: HtmlToMdOptions["structural"],
  opts: HtmlToMdOptions,
  stripNonVisible = false,
): HtmlToMdResult {
  const doc = createDocument(html);

  const title = doc.querySelector("title")?.textContent?.trim() || undefined;

  // title 由调用方作为标题使用，避免在正文里重复渲染
  const titleEl = doc.querySelector("title");
  if (titleEl) titleEl.remove();

  // head 里的 meta/script 不是正文：turndown 会把整个文档序列化，
  // 不删 head 时内联脚本源码会混进 markdown（Wikipedia 的 client-js 就是这种）。
  doc.querySelector("head")?.remove();

  if (structural === "clean") {
    removeNoiseElements(doc);
  }

  if (stripNonVisible) {
    for (const sel of NON_VISIBLE_SELECTORS) {
      each(doc.querySelectorAll(sel), (el) => el.remove());
    }
  }

  rewriteInlineDataImages(doc, opts.resolveImage);

  absolutizeUrls(doc, opts.baseUrl);

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  const markdown = collapseBlankLines(
    td.turndown(doc as unknown as Parameters<TurndownService["turndown"]>[0]),
  );

  return { markdown, title, contentChars: countVisibleChars(markdown) };
}

/**
 * HTML → markdown。
 * - domino 解析 DOM
 * - structural=clean 时移除导航/广告等噪音元素（仅限 body 后代）
 * - 相对 URL 转绝对
 * - turndown 转换（atx 标题、fenced 代码块）
 * - 压缩空白 + 截断到 maxOutputChars
 *
 * clean 结果正文为 0 时，再用同一份 HTML 做一次 full 转换兜底：激进选择器
 * （`[class*='menu']` 之类）可能把某些站点的正文容器误删，而 full 不做删除。
 * 兜底 pass 会排除 script/style/noscript 文本，只有确实存在可见正文才采用；
 * 真正空页（body 无文本 / 纯 JS 空壳）仍返回空。
 */
export function htmlToMarkdown(html: string, opts: HtmlToMdOptions): HtmlToMdResult {
  let result = renderMarkdown(html, opts.structural, opts);

  if (opts.structural === "clean" && result.contentChars === 0) {
    const full = renderMarkdown(html, "full", opts, true);
    if (full.contentChars > 0) result = full;
  }

  let markdown = result.markdown;
  if (markdown.length > opts.maxOutputChars) {
    markdown = markdown.slice(0, opts.maxOutputChars) + "\n\n…(内容已截断)";
  }

  return { markdown, title: result.title, contentChars: result.contentChars };
}
