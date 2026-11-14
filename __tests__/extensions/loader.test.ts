import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/logger.js";
import { extensionsDir, loadExtensions } from "../../src/extensions/loader.js";
import { createFetchRegistry } from "../../src/fetch/plugins/index.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writeExtension(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>,
  entryText: string,
  entryName = "index.mjs",
): string {
  const dir = path.join(extensionsDir(root), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "asg-plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(dir, entryName), entryText, "utf8");
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.0.0",
    api_version: 1,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  };
}

const FETCH_ENTRY = [
  "export const fetch = {",
  '  platform: "example",',
  '  capabilities: ["page"],',
  "  match: (url) => url.hostname === 'example.com',",
  "  async fetch() { return { ok: true, status: 200 }; },",
  "};",
  "",
].join("\n");

const ENGINE_ENTRY = [
  "export const engine = {",
  '  id: "gateway.search:demo",',
  '  group: "gateway.search",',
  '  name: "demo",',
  '  kind: "gateway",',
  '  displayName: "Demo 搜索",',
  "  routing: () => ['category:demo'],",
  "  available: () => true,",
  "  runtime: {",
  '    kind: "search",',
  "    plan: () => undefined,",
  "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
  "  },",
  "};",
  "",
].join("\n");

function fakeLogger(warnings: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
    close: () => {},
  } as unknown as Logger;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("加载 fetch 扩展", () => {
  it("读取命名导出并用 manifest 覆盖身份元数据", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), FETCH_ENTRY);

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.engines).toEqual([]);
    expect(loaded.fetch).toHaveLength(1);
    const plugin = loaded.fetch[0]!;
    expect(plugin).toMatchObject({
      id: "demo-fetch",
      name: "demo-fetch",
      displayName: "Demo Fetch",
      platform: "example",
      capabilities: ["page"],
    });
    expect(plugin.match(new URL("https://example.com/a"))).toBe(true);
    expect(plugin.match(new URL("https://other.com/a"))).toBe(false);
    await expect(plugin.fetch(new URL("https://example.com/a"), {} as never)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("platform 缺省回落到 manifest.id", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-fetch",
      manifest(),
      ["export const fetch = {", "  match: () => true,", "  async fetch() { return { ok: true }; },", "};"].join(
        "\n",
      ),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.fetch[0]!.platform).toBe("demo-fetch");
    expect(loaded.fetch[0]!.capabilities).toEqual([]);
  });
});

describe("加载 search 扩展", () => {
  it("读取 engine 导出并用于引擎注册表", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.engines).toHaveLength(1);
    expect(loaded.engines[0]).toMatchObject({
      id: "gateway.search:demo",
      group: "gateway.search",
      name: "demo",
      kind: "gateway",
      displayName: "Demo 搜索",
    });
    expect(loaded.engines[0]!.runtime?.kind).toBe("search");
  });

  it("同一插件可同时提供 fetch 与 search", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-both",
      manifest({ id: "demo-both", name: "Demo Both", provides: ["search", "fetch"] }),
      `${FETCH_ENTRY}\n${ENGINE_ENTRY}`,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["demo-both"]);
    expect(loaded.engines.map((engine) => engine.id)).toEqual(["gateway.search:demo"]);
  });
});

describe("坏包隔离与校验", () => {
  it("单个插件失败只记录 error，不影响其它插件", async () => {
    const root = tempRoot();
    writeExtension(root, "good-fetch", manifest({ id: "good-fetch" }), FETCH_ENTRY);
    writeExtension(root, "broken", manifest({ id: "broken" }), "export const fetch = {};\n");

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, { logger: fakeLogger(warnings) });

    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["good-fetch"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      id: "broken",
      error: expect.stringContaining("match / fetch"),
    });
    expect(warnings[0]).toContain("broken");
  });

  it("目录名与 manifest.id 不一致时跳过", async () => {
    const root = tempRoot();
    writeExtension(root, "wrong-dir", manifest({ id: "demo-fetch" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors[0]).toMatchObject({
      id: "wrong-dir",
      error: expect.stringContaining("目录名"),
    });
  });

  it("api_version 不兼容时跳过并记录 error", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest({ api_version: 2 }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors[0]).toMatchObject({
      id: "demo-fetch",
      error: expect.stringContaining("api_version"),
    });
  });

  it("缺少 manifest / 条目导入失败时只记录对应错误", async () => {
    const root = tempRoot();
    const missing = path.join(extensionsDir(root), "no-manifest");
    fs.mkdirSync(missing, { recursive: true });
    writeExtension(root, "import-fails", manifest({ id: "import-fails" }), FETCH_ENTRY);

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, {
      logger: fakeLogger(warnings),
      importModule: async (url) => {
        if (url.includes("import-fails")) throw new Error("boom");
        return import(url);
      },
    });

    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors).toEqual([
      { id: "import-fails", error: expect.stringContaining("boom") },
      { id: "no-manifest", error: expect.stringContaining("asg-plugin.json") },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it("search 导出缺少 runtime 时跳过", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "bad-engine",
      manifest({ id: "bad-engine", provides: ["search"] }),
      [
        "export const engine = {",
        '  id: "gateway.search:bad",',
        '  group: "gateway.search",',
        '  name: "bad",',
        "};",
      ].join("\n"),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.engines).toEqual([]);
    expect(loaded.errors[0]!.error).toContain("runtime");
  });

  it("扩展目录不存在时返回空结果", async () => {
    const loaded = await loadExtensions(tempRoot());
    expect(loaded).toEqual({ fetch: [], engines: [], errors: [] });
  });
});

describe("外部插件注册", () => {
  it("加载官方 id 后注册到 fetch 注册表", async () => {
    const root = tempRoot();
    writeExtension(root, "bilibili", manifest({ id: "bilibili", name: "外部 B 站" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["bilibili"]);

    const registry = createFetchRegistry(loaded.fetch);
    expect(registry.list().map((plugin) => plugin.id)).toEqual(["bilibili"]);
    const matched = registry.find(new URL("https://example.com/a"), {} as never);
    expect(matched?.id).toBe("bilibili");
    expect(matched?.displayName).toBe("外部 B 站");
  });
});
