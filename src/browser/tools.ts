import type { Page } from "playwright";
import type { BrowserPool } from "./pool.js";
import { assertPublicHttpUrl } from "../fetch/ssrf.js";
import { mcpSessionContext } from "../utils/session-context.js";
import { pageScreenshot, pageSnapshot } from "./snapshot.js";
import type { BrowserSettings, SsrfSettings } from "../settings/index.js";

/** browser_* 工具所需设置切片。 */
export interface BrowserToolSettings {
  browser: BrowserSettings;
  ssrf: SsrfSettings;
}

export interface ToolResult {
  ok: boolean;
  text?: string;
  screenshot?: { mimeType: string; base64: string };
  error?: string;
}

/** 选择器类操作（click / type / snapshot(target)）的超时上限：选择器合法但匹配不到元素时，别卡满全局超时。 */
export const SELECTOR_TIMEOUT_MS = 8000;

/** 选择器最大字符数：超长选择器（几千字符的后代链等）在 chromium 里解析极慢，直接拒绝。 */
export const MAX_SELECTOR_CHARS = 500;

/** 无 MCP sessionId（共享 page，如 fetch 渲染路径）时的串行化键。 */
const SHARED_KEY = "__shared__";

function okText(text: string): ToolResult {
  return { ok: true, text };
}

function errResult(err: unknown): ToolResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** 选择器超长时返回错误结果（不进入 playwright），否则返回 null。 */
function selectorLengthError(target: string): ToolResult | null {
  if (target.length <= MAX_SELECTOR_CHARS) return null;
  return { ok: false, error: `选择器过长（上限 ${MAX_SELECTOR_CHARS} 字符）` };
}

export class BrowserTools {
  /**
   * 每个会话一条 Promise 链。
   *
   * pool 只按 sessionId 复用 page，acquireSession() 拿到信号量后立刻释放，
   * 所以同一 MCP 会话内的并发 browser_* 会共用同一个 page 互相导航
   * （A 的 snapshot 读到 B 刚导航的页面）。这里按会话串行化：同 session
   * 严格串行，不同 session 仍可并行。
   */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private pool: BrowserPool,
    private deps: BrowserToolSettings,
  ) {}

  /** 串行化键：当前 MCP sessionId；无 session（共享 page）用固定键。 */
  private currentKey(): string {
    return mcpSessionContext.getStore() ?? SHARED_KEY;
  }

  /** 把 fn 挂到当前会话的链尾执行，参考 render.ts 的 serialize()。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.currentKey();
    const prev = this.chains.get(key) ?? Promise.resolve();
    // prev 成功或失败都继续执行下一次，避免一次报错卡死该会话后续调用
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    // 链排空后回收键，避免会话数增长导致 Map 无界
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** 选择器类操作的超时：全局超时与 SELECTOR_TIMEOUT_MS 取较小值。 */
  private selectorTimeoutMs(): number {
    return Math.min(this.deps.browser.timeout_ms, SELECTOR_TIMEOUT_MS);
  }

  async navigate(url: string): Promise<ToolResult> {
    return this.serialize(async () => {
      if (!this.pool.enabled) return errResult(new Error("浏览器功能未启用"));
      // SSRF：浏览器会自行解析并访问 URL，导航前校验协议 + 内网
      const check = await assertPublicHttpUrl(url, {
        exemptCidrs: this.deps.ssrf.private_ip_exempt_cidrs,
        enabled: this.deps.ssrf.block_private_ips,
      });
      if (!check.ok) {
        return errResult(
          new Error(
            check.reason === "private_ip" ? `SSRF 防护：拒绝内网地址 ${url}` : `非法 URL: ${url}`,
          ),
        );
      }
      try {
        const { page } = await this.pool.acquireSession();
        await page.goto(url, { waitUntil: "networkidle", timeout: this.deps.browser.timeout_ms });
        const snap = await pageSnapshot(page);
        if (!snap.ok) return errResult(new Error(snap.error));
        return okText(`已导航到 ${page.url()}\n\n${snap.snapshot}`);
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async snapshot(target?: string): Promise<ToolResult> {
    return this.serialize(async () => {
      if (target !== undefined) {
        const tooLong = selectorLengthError(target);
        if (tooLong) return tooLong;
      }
      try {
        const { page } = await this.pool.acquireSession();
        if (target) {
          // pageSnapshot 透传不了 timeout；先按选择器上限等元素出现，避免 ariaSnapshot 卡满全局超时
          await page
            .locator(target)
            .first()
            .waitFor({ state: "attached", timeout: this.selectorTimeoutMs() });
        }
        const snap = await pageSnapshot(page, target);
        if (!snap.ok) return errResult(new Error(snap.error));
        return okText(snap.snapshot!);
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async takeScreenshot(): Promise<ToolResult> {
    return this.serialize(async () => {
      try {
        const { page } = await this.pool.acquireSession();
        const shot = await pageScreenshot(page, this.deps.browser.screenshot);
        if (!shot.ok) return errResult(new Error(shot.error));
        return { ok: true, screenshot: { mimeType: shot.mimeType!, base64: shot.base64! } };
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async click(target: string): Promise<ToolResult> {
    return this.serialize(async () => {
      const tooLong = selectorLengthError(target);
      if (tooLong) return tooLong;
      try {
        const { page } = await this.pool.acquireSession();
        await page.locator(target).first().click({ timeout: this.selectorTimeoutMs() });
        const snap = await pageSnapshot(page);
        if (!snap.ok) return okText(`已点击 ${target}`);
        return okText(`已点击 ${target}\n\n${snap.snapshot}`);
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async type(target: string, text: string): Promise<ToolResult> {
    return this.serialize(async () => {
      const tooLong = selectorLengthError(target);
      if (tooLong) return tooLong;
      try {
        const { page } = await this.pool.acquireSession();
        await page.locator(target).first().fill(text, { timeout: this.selectorTimeoutMs() });
        const snap = await pageSnapshot(page);
        if (!snap.ok) return okText(`已输入 ${target}`);
        return okText(`已输入 ${target}\n\n${snap.snapshot}`);
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async scroll(direction: "up" | "down" | "top" | "bottom"): Promise<ToolResult> {
    return this.serialize(async () => {
      try {
        const { page } = await this.pool.acquireSession();
        if (direction === "top") await page.evaluate(() => window.scrollTo(0, 0));
        else if (direction === "bottom") await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else await page.evaluate((d) => window.scrollBy(0, d === "down" ? window.innerHeight : -window.innerHeight), direction);
        const snap = await pageSnapshot(page);
        if (!snap.ok) return okText(`已滚动 ${direction}`);
        return okText(`已滚动 ${direction}\n\n${snap.snapshot}`);
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async find(text: string): Promise<ToolResult> {
    return this.serialize(async () => {
      try {
        const { page } = await this.pool.acquireSession();
        const snap = await page.locator("body").ariaSnapshot();
        const lines = snap.split("\n").filter((l) => l.toLowerCase().includes(text.toLowerCase()));
        if (lines.length === 0) return okText(`未找到包含「${text}」的内容`);
        return okText(lines.slice(0, 30).join("\n"));
      } catch (err) {
        return errResult(err);
      }
    });
  }

  async close(): Promise<ToolResult> {
    return this.serialize(async () => {
      try {
        // 只关当前 MCP 会话的 context/page，不动共享渲染上下文与其它客户端
        await this.pool.closeSession();
        return okText("浏览器会话已关闭，资源已释放");
      } catch (err) {
        return errResult(err);
      }
    });
  }
}
