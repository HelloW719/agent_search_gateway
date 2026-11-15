/**
 * fetch 的“正文是否为空 / 是否 JS 空壳”判定。
 *
 * 只看 **转换后的正文**，不看 HTML 体积：现代 SPA 首屏 HTML 动辄几百 KB，
 * 按字节数判空会全部漏掉（ADR-0019）。
 */

/** 正文少于该字符数时视为“近空”，允许继续用其他信号确认。 */
export const MIN_CONTENT_CHARS = 200;

/** 每 KB HTML 的可见字符数；低于该值说明 HTML 很大但正文极少。 */
export const MIN_CONTENT_DENSITY = 1;

export type JsShellReason = "cf" | "empty" | "sparse";

export interface JsShellAnalysis {
  /** 是否应在 auto 模式下升级到浏览器渲染。 */
  likely: boolean;
  reason?: JsShellReason;
  /** 正文可见字符数（不含图片、URL、标点与空白）。 */
  contentChars: number;
  htmlBytes: number;
  hasScripts: boolean;
  hasExternalScripts: boolean;
  hasSpaMarkers: boolean;
  hasJsNoscript: boolean;
  hasCfChallenge: boolean;
  meaningfulNodes: number;
}

/**
 * 统计“可见正文”字符数：去掉图片、链接 URL、裸 URL、HTML 实体、标点与空白，
 * 只保留字母/数字/CJK。图片（尤其 data: base64）不应当作正文。
 */
export function countVisibleChars(text: string): number {
  if (!text) return 0;
  const stripped = text
    // 代码块保留内容，只去掉围栏标记
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*/g, " "))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/&[a-z][a-z0-9]+;/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return Array.from(stripped).length;
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

/**
 * 结合正文长度与 HTML 特征判断是否疑似 JS 空壳。
 *
 * 触发条件：
 * - CF/JS 挑战页：直接升级（走 FlareSolverr）；
 * - 正文为 0 且有 script/noscript 提示；
 * - 正文 < MIN_CONTENT_CHARS，且（SPA 挂载点 / 无正文节点 / 密度过低），
 *   同时存在外链脚本。
 *
 * 正常短文只要正文节点存在且密度正常就不会触发。
 */
export function analyzeJsShell(html: string, contentChars: number): JsShellAnalysis {
  const hasScripts = /<script\b/i.test(html);
  const hasExternalScripts = /<script\b[^>]*(?:\bsrc\s*=|\btype\s*=\s*["']module["'])/i.test(html);
  const hasSpaMarkers =
    /id\s*=\s*["'](?:app|root|__next|__nuxt)["']|__NEXT_DATA__|__NUXT__|data-reactroot|<app-root\b/i.test(
      html,
    );
  const hasJsNoscript =
    /<noscript\b[^>]*>[\s\S]{0,500}?(?:javascript|enable\s+js|requires?\s+javascript)/i.test(html);

  // 只认真正的挑战页特征；`challenge-platform` 会被普通 Cloudflare 站点注入，
  // 不能单独作为判据。正文较长的页面里出现 “just a moment” 也不应误判。
  const hasCfChallenge =
    contentChars < 1000 &&
    /cf-challenge|just a moment|cf-browser-verification|__cf_chl|_cf_chl_opt/i.test(html);

  const meaningfulNodes = countMatches(html, /<(?:p|article|h[1-6]|li|blockquote|pre)\b/gi);
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const density = contentChars / Math.max(htmlBytes / 1024, 1);

  let reason: JsShellReason | undefined;
  if (hasCfChallenge) {
    reason = "cf";
  } else if (contentChars === 0) {
    if (hasScripts || hasJsNoscript) reason = "empty";
  } else if (
    contentChars < MIN_CONTENT_CHARS &&
    (hasJsNoscript ||
      (hasExternalScripts &&
        (hasSpaMarkers || meaningfulNodes === 0 || density < MIN_CONTENT_DENSITY)))
  ) {
    reason = "sparse";
  }

  return {
    likely: reason !== undefined,
    ...(reason ? { reason } : {}),
    contentChars,
    htmlBytes,
    hasScripts,
    hasExternalScripts,
    hasSpaMarkers,
    hasJsNoscript,
    hasCfChallenge,
    meaningfulNodes,
  };
}
