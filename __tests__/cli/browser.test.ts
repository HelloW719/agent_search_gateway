import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BrowserPool } from "../../src/browser/pool.js";
import { BrowserTools, MAX_SELECTOR_CHARS, SELECTOR_TIMEOUT_MS } from "../../src/browser/tools.js";
import type { Reporter } from "../../src/cli/output.js";
import {
  browserStatus,
  installBrowser,
  playwrightCacheDir,
} from "../../src/cli/deps/browser.js";
import type { StreamRunner } from "../../src/cli/deps/plugins.js";
import { browserToolDeps, makeSettings } from "../helpers/settings.js";

const tempDirs: string[] = [];

function tempDir(prefix = "asg-browser-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function reporter(): Reporter {
  return {
    mode: "jsonl",
    event: vi.fn(),
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter;
}

function makeInstallRoot(): { root: string; cli: string } {
  const root = tempDir("asg-browser-root-");
  const release = path.join(root, "release");
  const cli = path.join(release, "node_modules", "playwright", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "", "utf8");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "current.json"),
    `${JSON.stringify({ dir: release })}\n`,
    "utf8",
  );
  return { root, cli };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Playwright 缓存目录", () => {
  it("按平台返回约定路径", () => {
    const home = "/home/tester";
    expect(playwrightCacheDir({ platform: "linux", home })).toBe(
      path.join(home, ".cache", "ms-playwright"),
    );
    expect(playwrightCacheDir({ platform: "darwin", home })).toBe(
      path.join(home, "Library", "Caches", "ms-playwright"),
    );
    expect(
      playwrightCacheDir({
        platform: "win32",
        home: "C:\\Users\\tester",
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      }),
    ).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "ms-playwright"));
    expect(
      playwrightCacheDir({
        platform: "win32",
        home: "C:\\Users\\tester",
        env: {},
      }),
    ).toBe(path.join("C:\\Users\\tester", "AppData", "Local", "ms-playwright"));
  });

  it("只按目录前缀识别 headless shell 与完整 chromium", () => {
    const linuxShell = tempDir();
    fs.mkdirSync(path.join(linuxShell, ".cache", "ms-playwright", "chromium_headless_shell-1200"), {
      recursive: true,
    });
    expect(browserStatus({ platform: "linux", home: linuxShell })).toMatchObject({
      headless_shell: true,
      chromium: false,
      path: path.join(linuxShell, ".cache", "ms-playwright"),
    });

    const linuxFull = tempDir();
    fs.mkdirSync(path.join(linuxFull, ".cache", "ms-playwright", "chromium-1200"), {
      recursive: true,
    });
    expect(browserStatus({ platform: "linux", home: linuxFull })).toMatchObject({
      headless_shell: false,
      chromium: true,
    });

    const empty = tempDir();
    expect(browserStatus({ platform: "linux", home: empty })).toMatchObject({
      headless_shell: false,
      chromium: false,
    });
  });
});

describe("browser install 参数", () => {
  it("默认只装 headless shell，--full 装完整 chromium", async () => {
    const { root, cli } = makeInstallRoot();
    const calls: string[][] = [];
    const runner: StreamRunner = async (_command, args) => {
      calls.push(args);
      return { code: 0, signal: null };
    };

    await installBrowser({ root, full: false, reporter: reporter(), runner });
    await installBrowser({ root, full: true, reporter: reporter(), runner });

    expect(calls[0]).toEqual([cli, "install", "chromium", "--only-shell"]);
    expect(calls[1]).toEqual([cli, "install", "chromium"]);
  });

  it("安装失败抛 BROWSER_NOT_INSTALLED（退出码 1）", async () => {
    const { root } = makeInstallRoot();
    const runner: StreamRunner = async () => ({ code: 1, signal: null });

    await expect(
      installBrowser({ root, full: false, reporter: reporter(), runner }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_INSTALLED", exitCode: 1 });
  });

  it("release 内缺少 Playwright CLI 时同样报 BROWSER_NOT_INSTALLED", async () => {
    const root = tempDir("asg-browser-nocli-");
    const release = path.join(root, "release");
    fs.mkdirSync(release, { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "current.json"),
      `${JSON.stringify({ dir: release })}\n`,
      "utf8",
    );

    const runner: StreamRunner = async () => ({ code: 0, signal: null });
    await expect(
      installBrowser({ root, full: false, reporter: reporter(), runner }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_INSTALLED", exitCode: 1 });
  });
});

type Recorded = { method: string; args: unknown[] };

/** 假 page：只记录 locator/动作调用，不启动 playwright。 */
function makeFakePage(opts: { snapshotText?: string; failWith?: Error } = {}): {
  page: Page;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const locator = (selector: string) => {
    calls.push({ method: "locator", args: [selector] });
    const handle = {
      first: () => handle,
      click: async (options?: unknown) => {
        calls.push({ method: "click", args: [options] });
        if (opts.failWith) throw opts.failWith;
      },
      fill: async (text: string, options?: unknown) => {
        calls.push({ method: "fill", args: [text, options] });
        if (opts.failWith) throw opts.failWith;
      },
      waitFor: async (options?: unknown) => {
        calls.push({ method: "waitFor", args: [options] });
        if (opts.failWith) throw opts.failWith;
      },
      ariaSnapshot: async () => {
        calls.push({ method: "ariaSnapshot", args: [] });
        return opts.snapshotText ?? "snapshot";
      },
    };
    return handle;
  };
  return { page: { locator } as unknown as Page, calls };
}

function makeTools(page: Page, timeoutMs = 30000) {
  const pool = { acquireSession: async () => ({ page }) } as unknown as BrowserPool;
  const settings = makeSettings({ browser: { timeout_ms: timeoutMs } });
  return { tools: new BrowserTools(pool, browserToolDeps(settings)) };
}

describe("BrowserTools 选择器超时与长度上限", () => {
  it("超长选择器立即报错且不调用 locator", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);
    const long = `#${"a".repeat(MAX_SELECTOR_CHARS)}`;

    const results = [
      await tools.click(long),
      await tools.type(long, "x"),
      await tools.snapshot(long),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(`选择器过长（上限 ${MAX_SELECTOR_CHARS} 字符）`);
    }
    expect(calls).toHaveLength(0);
  });

  it("click / type 传入的 timeout 不超过 SELECTOR_TIMEOUT_MS", async () => {
    expect(SELECTOR_TIMEOUT_MS).toBeLessThanOrEqual(8000);
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);

    await tools.click("#btn");
    await tools.type("#input", "hello");

    const clickOptions = calls.find((c) => c.method === "click")!.args[0] as { timeout: number };
    const fillOptions = calls.find((c) => c.method === "fill")!.args[1] as { timeout: number };
    expect(clickOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
    expect(fillOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
    expect(clickOptions.timeout).toBeLessThanOrEqual(8000);
  });

  it("全局超时更小时取全局值", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page, 3000);

    await tools.click("#btn");

    const clickOptions = calls.find((c) => c.method === "click")!.args[0] as { timeout: number };
    expect(clickOptions.timeout).toBe(3000);
  });

  it("snapshot(target) 用受限超时等待选择器", async () => {
    const { page, calls } = makeFakePage();
    const { tools } = makeTools(page);

    const r = await tools.snapshot("#result");
    expect(r.ok).toBe(true);
    const waitOptions = calls.find((c) => c.method === "waitFor")!.args[0] as { timeout: number };
    expect(waitOptions.timeout).toBe(SELECTOR_TIMEOUT_MS);
  });

  it("选择器超时时返回 playwright 原文错误", async () => {
    const timeoutErr = Object.assign(new Error("locator.click: Timeout 8000ms exceeded."), {
      name: "TimeoutError",
    });
    const { page } = makeFakePage({ failWith: timeoutErr });
    const { tools } = makeTools(page);

    const r = await tools.click("#btn");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("locator.click: Timeout 8000ms exceeded.");
  });
});
