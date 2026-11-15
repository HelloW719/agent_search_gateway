import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../src/logger.js";
import { createServer, startHttpServer } from "../src/server.js";
import { makeSecrets, makeSettings } from "./helpers/settings.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

/** 本地假 embedding 服务：按输入条数返回固定维度向量。 */
const mockEmbedding = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let inputs: string[] = [];
    try {
      const parsed = JSON.parse(body) as { input?: unknown };
      inputs = Array.isArray(parsed.input) ? parsed.input.map(String) : [];
    } catch {
      inputs = [];
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: inputs.map((_text, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      }),
    );
  });
});

let embedPort = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => mockEmbedding.listen(0, "127.0.0.1", resolve));
  embedPort = (mockEmbedding.address() as AddressInfo).port;
});

afterAll(() => {
  mockEmbedding.close();
});

describe("GET /health 与 MCP health 共用语义层状态", () => {
  it("embedding 启用且探针成功时报告 up", async () => {
    const settings = makeSettings({
      gateway: { port: 0 },
      searxng: { url: "http://127.0.0.1:1" },
      flaresolverr: { url: "http://127.0.0.1:1" },
      embedding: {
        enabled: true,
        provider: "openai",
        base_url: `http://127.0.0.1:${embedPort}`,
        model: "BAAI/bge-m3",
        dim: 0,
        timeout_ms: 3000,
      },
      corpus: { enabled: false },
    });

    const http = await startHttpServer({ settings, secrets: makeSecrets(), logger: silentLogger }, createServer);
    const { port } = new URL(http.url);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        embedding?: { status?: string; model?: string; dim?: number };
        corpus?: unknown;
      };
      expect(body.embedding).toEqual({ status: "up", model: "BAAI/bge-m3", dim: 3 });
      expect(body.corpus).toBeUndefined();
    } finally {
      await http.close();
    }
  });
});
