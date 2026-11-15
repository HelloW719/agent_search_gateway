import type { BrowserPool } from "./pool.js";
import type { Logger } from "../logger.js";
import { assertPublicHttpUrl } from "../fetch/ssrf.js";
import type { BrowserSettings, SsrfSettings } from "../settings/index.js";

/** fetch 路由③ 渲染所需的设置切片。 */
export interface RenderSettings {
  browser: BrowserSettings;
  ssrf: SsrfSettings;
}

export interface RenderWaitOptions {
  /** 等正文至少达到该字符数；0 = 只等一次，不轮询。默认 1。 */
  minTextChars?: number;
  /** networkidle 的等待上限；默认 3000ms。 */
  networkIdleTimeoutMs?: number;
  /** 正文轮询的等待上限；默认 2000ms。 */
  settleTimeoutMs?: number;
}

export interface RenderResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  errorMessage?: string;
}

/**
 * fetch 渲染共用同一个共享 page（无 MCP session 时），并发抓取会互相导航。
 * FlareSolverr 有进程级信号量，playwright 没有；这里串行化，避免 A 的
 * `page.content()` 读到 B 的页面。
 */
let renderChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderChain.then(fn, fn);
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * fetch 路由③：用 playwright 渲染页面（复杂 SPA）。
 *
 * - `goto(commit)` + 有界 `domcontentloaded`：不把首屏脚本阻塞等同整页失败；
 * - `networkidle` 只做有界等待，超时继续（轮询正文）；
 * - 可选 `wait_for_selector`（配置），等异步内容出现；
 * - 轮询 `body.innerText` 长度，给 SPA 异步渲染留时间；
 * - 提取渲染后 HTML。
 */
export function renderWithPlaywright(
  pool: BrowserPool,
  deps: RenderSettings,
  logger: Logger,
  url: string,
  opts: RenderWaitOptions = {},
): Promise<RenderResult> {
  if (!pool.enabled) {
    return Promise.resolve({ ok: false, errorMessage: "浏览器功能未启用（browser.enabled=false）" });
  }

  return serialize(async () => {
    // SSRF：浏览器渲染会自行解析并访问 URL（含重定向），导航前校验
    const check = await assertPublicHttpUrl(url, {
      exemptCidrs: deps.ssrf.private_ip_exempt_cidrs,
      enabled: deps.ssrf.block_private_ips,
    });
    if (!check.ok) {
      return {
        ok: false,
        errorMessage:
          check.reason === "private_ip" ? `SSRF 防护：拒绝内网地址 ${url}` : `非法 URL: ${url}`,
      };
    }

    try {
      const { page } = await pool.acquireSession();
      // 先只等导航提交，避免重脚本站点的 DOMContentLoaded 把整次 fetch 拖到 30s。
      // 之后用有界等待补 DCL / networkidle / 正文轮询。
      await page.goto(url, {
        waitUntil: "commit",
        timeout: Math.min(deps.browser.timeout_ms, 10000),
      });
      try {
        await page.waitForLoadState("domcontentloaded", {
          timeout: Math.min(5000, deps.browser.timeout_ms),
        });
      } catch {
        logger.debug(`domcontentloaded 超时（5s），继续读取当前 DOM: ${url}`);
      }

      const idleTimeout = Math.min(opts.networkIdleTimeoutMs ?? 3000, deps.browser.timeout_ms);
      try {
        await page.waitForLoadState("networkidle", { timeout: idleTimeout });
      } catch {
        logger.debug(`networkidle 超时（${idleTimeout}ms），继续读取当前 DOM: ${url}`);
      }

      const sel = deps.browser.wait_for_selector;
      if (sel && sel.trim().length > 0) {
        try {
          await page.waitForSelector(sel.trim(), { timeout: deps.browser.timeout_ms });
        } catch {
          logger.debug(`wait_for_selector 超时: ${sel}`);
        }
      }

      const minChars = opts.minTextChars ?? 1;
      if (minChars > 0) {
        const settleTimeout = opts.settleTimeoutMs ?? 2000;
        const deadline = Date.now() + settleTimeout;
        for (;;) {
          const length = await page
            .evaluate(() => document.body?.innerText?.trim().length ?? 0)
            .catch(() => 0);
          if (length >= minChars || Date.now() >= deadline) break;
          await page.waitForTimeout(150);
        }
      }

      const html = await page.content();
      const finalUrl = page.url();
      return { ok: true, html, finalUrl };
    } catch (err) {
      return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
    }
  });
}
