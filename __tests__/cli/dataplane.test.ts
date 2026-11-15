import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run as fetchRunRaw } from "../../src/cli/commands/fetch.js";
import { run as searchRunRaw } from "../../src/cli/commands/search.js";
import { resolveDataPlane } from "../../src/cli/dataplane.js";
import { Reporter } from "../../src/cli/output.js";
import type { Logger } from "../../src/logger.js";
import { startHttpServer } from "../../src/server.js";
import { makeSecrets, makeSettings } from "../helpers/settings.js";

const TOKEN = "test-token";
const reporter = new Reporter({ json: true, jsonl: false });
const roots: string[] = [];

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

let lastCall: { tool: string; args: Record<string, unknown> } | undefined;
let server: Awaited<ReturnType<typeof startHttpServer>>;
let port = 0;

function fakeMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "fake-gateway", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "search",
    {
      inputSchema: {
        query: z.string().optional(),
        image_path: z.string().optional(),
        language: z.string().optional(),
        safesearch: z.string().optional(),
        categories: z.string().optional(),
        engines: z.string().optional(),
        min_score: z.number().optional(),
        num_results: z.number().optional(),
        fanout: z.number().optional(),
      },
    },
    async (args) => {
      lastCall = { tool: "search", args };
      if (args.query === "fail") {
        return {
          content: [{ type: "text" as const, text: "[SEARCH_UPSTREAM] upstream down" }],
          isError: true,
        };
      }
      if (args.query === "legacy-fail") {
        // 旧网关没有 isError，只有文本前缀。
        return { content: [{ type: "text" as const, text: "[SEARCH_TIMEOUT] old gateway" }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
    },
  );

  mcp.registerTool(
    "fetch",
    {
      inputSchema: {
        url: z.string(),
        max_chars: z.number().optional(),
        render: z.enum(["auto", "always", "never"]).optional(),
      },
    },
    async (args) => {
      lastCall = { tool: "fetch", args };
      if (args.url.includes("fail")) {
        return {
          content: [{ type: "text" as const, text: "[FETCH_BLOCKED] blocked by test" }],
          isError: true,
        };
      }
      if (args.url.includes("plain")) {
        // 普通正文可以以 [INFO] 开头，不应误判为数据面失败。
        return { content: [{ type: "text" as const, text: "[INFO] hello" }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
    },
  );

  return mcp;
}

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const value = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(value));
    });
  });
}

function makeRoot(options: { port?: number; token?: string; host?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asg-dataplane-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "gateway.yaml"),
    [
      "gateway:",
      `  host: ${options.host ?? "127.0.0.1"}`,
      `  port: ${options.port ?? port}`,
      "",
    ].join("\n"),
    "utf8",
  );
  if (options.token !== "") {
    fs.writeFileSync(
      path.join(root, "secrets.yaml"),
      ["gateway:", `  token: ${options.token ?? TOKEN}`, ""].join("\n"),
      "utf8",
    );
  }
  return root;
}

function asSearch(root: string, rest: string[]) {
  return searchRunRaw({ root, reporter, rest: [...rest] });
}

function asFetch(root: string, rest: string[]) {
  return fetchRunRaw({ root, reporter, rest: [...rest] });
}

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "asg-dataplane-http-"));
  roots.push(base);
  server = await startHttpServer(
    {
      settings: makeSettings({
        gateway: { host: "127.0.0.1", port: 0 },
        fetch: { files_route: false, download_dir: path.join(base, "downloads") },
      }),
      secrets: makeSecrets({ gateway: { token: TOKEN } }),
      logger: silentLogger,
      sessionIdleTtlMs: 60_000,
      sessionSweepIntervalMs: 60_000,
    },
    async () => fakeMcpServer(),
  );
  port = Number(new URL(server.url).port);
});

afterAll(async () => {
  await server.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  lastCall = undefined;
});

describe("asg search / fetch 数据面命令", () => {
  it("search 把 CLI 选项映射到 MCP 参数并输出 markdown", async () => {
    const root = makeRoot();
    const result = await asSearch(root, [
      "hello world",
      "--categories",
      "news",
      "--engines",
      "google",
      "--language",
      "zh-CN",
      "--safesearch",
      "1",
      "--num-results",
      "5",
      "--fanout",
      "2",
      "--min-score",
      "0.4",
    ]);

    const data = result.data as any;
    expect(result.ok).toBeUndefined();
    expect(result.exitCode).toBeUndefined();
    expect(data).toMatchObject({
      tool: "search",
      endpoint: `http://127.0.0.1:${port}/mcp`,
      ok: true,
      code: null,
    });
    expect(typeof data.elapsed_ms).toBe("number");
    expect(JSON.parse(data.text)).toEqual({
      query: "hello world",
      categories: "news",
      engines: "google",
      language: "zh-CN",
      safesearch: "1",
      num_results: 5,
      fanout: 2,
      min_score: 0.4,
    });
    expect(lastCall).toEqual({ tool: "search", args: JSON.parse(data.text) });
  });

  it("fetch 映射 url / max_chars", async () => {
    const root = makeRoot();
    const result = await asFetch(root, ["https://example.com/a", "--max-chars", "123"]);
    const data = result.data as any;

    expect(data).toMatchObject({ tool: "fetch", ok: true, code: null, render: "auto" });
    expect(JSON.parse(data.text)).toEqual({
      url: "https://example.com/a",
      max_chars: 123,
    });
  });

  it("fetch 映射 --render", async () => {
    const root = makeRoot();
    const result = await asFetch(root, ["https://example.com/a", "--render", "always"]);
    const data = result.data as any;

    expect(data).toMatchObject({ tool: "fetch", ok: true, render: "always" });
    expect(JSON.parse(data.text)).toEqual({
      url: "https://example.com/a",
      render: "always",
    });
  });

  it("fetch 拒绝非法 --render", async () => {
    const root = makeRoot();
    await expect(asFetch(root, ["https://example.com/a", "--render", "sometimes"])).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
    });
  });

  it("--image-path 转成绝对路径，query 可为空", async () => {
    const root = makeRoot();
    const result = await asSearch(root, [
      "--image-path",
      "./test.jpg",
      "--categories",
      "search_by_image",
    ]);
    const data = result.data as any;
    expect(JSON.parse(data.text)).toEqual({
      query: "",
      image_path: path.resolve("./test.jpg"),
      categories: "search_by_image",
    });
  });

  it("只有 --categories 时允许空 query（如 weibo_hot）", async () => {
    const root = makeRoot();
    await asSearch(root, ["--categories", "weibo_hot"]);
    expect(lastCall).toEqual({ tool: "search", args: { query: "", categories: "weibo_hot" } });
  });

  it("-- 之后的 token 当作 query，不按选项解析", async () => {
    const root = makeRoot();
    await asSearch(root, ["--", "hello --world"]);
    expect(lastCall).toEqual({ tool: "search", args: { query: "hello --world" } });
  });

  it("下一个 token 是选项时报告真正缺值的选项", async () => {
    const root = makeRoot();
    await expect(
      asFetch(root, ["https://example.com/a", "--render", "--max-chars", "100"]),
    ).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--render 需要一个值"),
    });
    await expect(
      asSearch(root, ["x", "--categories", "--engines", "bing"]),
    ).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--categories 需要一个值"),
    });
  });

  it("单横线负值仍作为选项值，交给范围校验", async () => {
    const root = makeRoot();
    await expect(asFetch(root, ["https://example.com/a", "--max-chars", "-5"])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--max-chars 需要 1-200000"),
    });
  });

  it("fetch 的 -- 之后 URL 仍作为位置参数", async () => {
    const root = makeRoot();
    const result = await asFetch(root, ["--", "https://example.com/a"]);
    expect(JSON.parse((result.data as any).text)).toEqual({ url: "https://example.com/a" });
  });

  it("单横线短选项按未知选项报错，且不调用网关", async () => {
    const root = makeRoot();
    await expect(asSearch(root, ["-x"])).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("未知选项：-x"),
    });
    await expect(asFetch(root, ["https://example.com/a", "-abc"])).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("未知选项：-abc"),
    });
    expect(lastCall).toBeUndefined();
  });

  it("-- 之后的单横线 token 仍可作为 query", async () => {
    const root = makeRoot();
    await asSearch(root, ["--", "-x"]);
    expect(lastCall).toEqual({ tool: "search", args: { query: "-x" } });
  });

  it("负数值仍走范围校验而不是未知选项", async () => {
    const root = makeRoot();
    await expect(asSearch(root, ["x", "--num-results", "-1"])).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--num-results 需要"),
    });
  });

  it("重复指定同一选项报错，不静默覆盖", async () => {
    const root = makeRoot();
    await expect(
      asFetch(root, ["https://example.com/a", "--render", "never", "--render", "always"]),
    ).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--render 只能指定一次"),
    });
    await expect(asSearch(root, ["x", "--fanout", "2", "--fanout", "3"])).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--fanout 只能指定一次"),
    });
    await expect(
      asFetch(root, ["https://example.com/a", "--render=never", "--render=always"]),
    ).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--render 只能指定一次"),
    });
    expect(lastCall).toBeUndefined();
  });

  it("不同选项各自出现一次时正常解析", async () => {
    const root = makeRoot();
    await asSearch(root, ["x", "--fanout", "2", "--num-results", "3"]);
    expect(lastCall).toEqual({
      tool: "search",
      args: { query: "x", num_results: 3, fanout: 2 },
    });
  });

  it("--json 数据面失败时带上游错误码与完整文本", async () => {
    const root = makeRoot();
    const result = await asSearch(root, ["fail"]);
    const data = result.data as any;

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(data).toMatchObject({
      tool: "search",
      ok: false,
      code: "SEARCH_UPSTREAM",
      text: "[SEARCH_UPSTREAM] upstream down",
    });
    expect(result.error).toMatchObject({
      code: "SEARCH_UPSTREAM",
      message: "upstream down",
    });
  });

  it("fetch 工具失败同样透传错误码", async () => {
    const root = makeRoot();
    const result = await asFetch(root, ["https://fail.example"]);
    const data = result.data as any;

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(data).toMatchObject({ tool: "fetch", ok: false, code: "FETCH_BLOCKED" });
  });

  it("兼容旧网关：没有 isError 时按数据面错误码前缀判失败", async () => {
    const root = makeRoot();
    const result = await asSearch(root, ["legacy-fail"]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect((result.data as any).code).toBe("SEARCH_TIMEOUT");
  });

  it("正文以普通 [INFO] 开头时仍按成功处理", async () => {
    const root = makeRoot();
    const result = await asFetch(root, ["https://plain.example"]);
    expect(result.ok).toBeUndefined();
    expect((result.data as any)).toMatchObject({ ok: true, text: "[INFO] hello" });
  });

  it("0.0.0.0 监听地址自动换成 127.0.0.1", () => {
    const root = makeRoot({ host: "0.0.0.0" });
    expect(resolveDataPlane(root).endpoint).toBe(`http://127.0.0.1:${port}/mcp`);
  });

  it("网关未启动时报 SERVICE_DOWN", async () => {
    const downPort = await unusedPort();
    const root = makeRoot({ port: downPort });
    await expect(asSearch(root, ["hello"])).rejects.toMatchObject({
      code: "SERVICE_DOWN",
      exitCode: 1,
    });
  });

  it("token 错误时报 GATEWAY_UNAUTHORIZED", async () => {
    const root = makeRoot({ token: "wrong-token" });
    await expect(asSearch(root, ["hello"])).rejects.toMatchObject({
      code: "GATEWAY_UNAUTHORIZED",
      exitCode: 1,
    });
  });

  it("参数错误统一退出码 2", async () => {
    const root = makeRoot();
    await expect(asSearch(root, [])).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    await expect(asSearch(root, ["a", "b"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(asSearch(root, ["x", "--fanout", "5"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(asSearch(root, ["x", "--bogus"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(asFetch(root, [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(asFetch(root, ["ftp://example.com"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(asFetch(root, ["https://example.com", "--max-chars", "0"])).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
