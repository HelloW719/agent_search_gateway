import { describe, expect, it } from "vitest";
import {
  isValidEntryName,
  isValidExtensionId,
  isValidExtensionVersion,
  parseManifest,
} from "../../src/extensions/manifest.js";

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.2.3",
    api_version: 1,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  });
}

describe("插件 manifest", () => {
  it("接受最小 manifest 与可选 description", () => {
    const parsed = parseManifest(manifest({ description: "示例插件" }));
    expect(parsed).toEqual({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      api_version: 1,
      provides: ["fetch"],
      entry: "index.mjs",
      description: "示例插件",
    });
  });

  it("接受 search、fetch 或两者，并保留声明顺序", () => {
    expect(parseManifest(manifest({ provides: ["search"] })).provides).toEqual(["search"]);
    expect(parseManifest(manifest({ provides: ["search", "fetch"] })).provides).toEqual([
      "search",
      "fetch",
    ]);
  });

  it("拒绝非法 JSON，并给出中文说明", () => {
    expect(() => parseManifest("{")).toThrow(/不是合法 JSON/);
  });

  it("拒绝未知字段", () => {
    expect(() => parseManifest(manifest({ extra: true }))).toThrow(/校验失败/);
    expect(() => parseManifest(manifest({ extra: true }))).toThrow(/[Uu]nrecognized|extra/);
  });

  it("校验 id 规则", () => {
    for (const id of ["ab", "ABC", "-abc", "abc-", ".abc", "a".repeat(65), "中文"]) {
      expect(() => parseManifest(manifest({ id })), id).toThrow(/id 必须/);
    }
    expect(isValidExtensionId("abc")).toBe(true);
    expect(isValidExtensionId("a.b_c-1")).toBe(true);
  });

  it("校验 name 与 version", () => {
    expect(() => parseManifest(manifest({ name: "" }))).toThrow(/name/);
    expect(() => parseManifest(manifest({ name: "x".repeat(81) }))).toThrow(/name/);
    expect(() => parseManifest(manifest({ version: "1.2" }))).toThrow(/version/);
    expect(() => parseManifest(manifest({ version: "v1.2.3" }))).toThrow(/version/);
    expect(isValidExtensionVersion("1.2.3-beta.1")).toBe(true);
  });

  it("api_version 接受 1 或 2", () => {
    expect(parseManifest(manifest()).api_version).toBe(1);
    expect(parseManifest(manifest({ api_version: 2 })).api_version).toBe(2);
    expect(() => parseManifest(manifest({ api_version: 3 }))).toThrow(/api_version/);
    expect(() => parseManifest(manifest({ api_version: "1" }))).toThrow(/api_version/);
  });

  it("provides 非空、不能重复、只能是 search/fetch", () => {
    expect(() => parseManifest(manifest({ provides: [] }))).toThrow(/至少声明一项/);
    expect(() => parseManifest(manifest({ provides: ["fetch", "fetch"] }))).toThrow(/重复/);
    expect(() => parseManifest(manifest({ provides: ["other"] }))).toThrow(/provides/);
  });

  it("entry 只能是单个 .mjs/.js 文件名", () => {
    for (const entry of [
      "dist/index.mjs",
      "../index.mjs",
      "/index.mjs",
      "index.txt",
      "C:\\index.mjs",
      "C:index.js",
      "index..mjs",
      ".mjs",
    ]) {
      expect(() => parseManifest(manifest({ entry })), entry).toThrow(/entry/);
    }
    expect(isValidEntryName("index.js")).toBe(true);
    expect(isValidEntryName("x.y.mjs")).toBe(true);
    expect(isValidEntryName("index_mjs.js")).toBe(true);
  });
});

describe("插件 manifest 的 backends（api_version 2）", () => {
  const backend = {
    id: "demo-api",
    name: "Demo API",
    description: "示例后端",
    aliases: ["demo_old", "demo-old"],
  };

  it("api_version 2 + 合法 backends 通过并原样保留", () => {
    const parsed = parseManifest(
      manifest({ api_version: 2, backends: [backend] }),
    );
    expect(parsed.backends).toEqual([backend]);
  });

  it("没有 backends 时 1 和 2 都通过", () => {
    expect(parseManifest(manifest())).not.toHaveProperty("backends");
    expect(parseManifest(manifest({ api_version: 2 }))).not.toHaveProperty("backends");
  });

  it("api_version 1 不允许声明非空 backends", () => {
    expect(() => parseManifest(manifest({ backends: [backend] }))).toThrow(/backends/);
    expect(() => parseManifest(manifest({ backends: [backend] }))).toThrow(/api_version: 2/);
    // 空数组不引入任何后端，兼容旧 manifest。
    expect(parseManifest(manifest({ backends: [] })).backends).toEqual([]);
  });

  it("backends 不能有重复 id", () => {
    expect(() =>
      parseManifest(
        manifest({
          api_version: 2,
          backends: [backend, { id: "demo-api", name: "另一个" }],
        }),
      ),
    ).toThrow(/重复 id/);
  });

  it("校验 backend id 规则", () => {
    for (const id of ["ab", "ABC", "-abc", "abc-", ".abc", "a".repeat(65), "中文"]) {
      expect(
        () => parseManifest(manifest({ api_version: 2, backends: [{ ...backend, id }] })),
        id,
      ).toThrow(/backends\[\]\.id|重复 id/);
    }
  });

  it("校验 backend name 长度", () => {
    expect(() =>
      parseManifest(manifest({ api_version: 2, backends: [{ id: "demo-api", name: "" }] })),
    ).toThrow(/backends\[\]\.name/);
    expect(() =>
      parseManifest(
        manifest({ api_version: 2, backends: [{ id: "demo-api", name: "x".repeat(81) }] }),
      ),
    ).toThrow(/backends\[\]\.name/);
  });

  it("aliases 不能包含空串或重复项", () => {
    expect(() =>
      parseManifest(
        manifest({
          api_version: 2,
          backends: [{ ...backend, aliases: ["ok", ""] }],
        }),
      ),
    ).toThrow(/aliases/);
    expect(() =>
      parseManifest(
        manifest({
          api_version: 2,
          backends: [{ ...backend, aliases: ["same", "same"] }],
        }),
      ),
    ).toThrow(/aliases/);
  });

  it("backend 元素是严格对象", () => {
    expect(() =>
      parseManifest(manifest({ api_version: 2, backends: [{ ...backend, extra: true }] })),
    ).toThrow(/[Uu]nrecognized|extra/);
    expect(() => parseManifest(manifest({ api_version: 2, backends: ["demo-api"] }))).toThrow(
      /backends/,
    );
  });

  it("顶层 manifest 的未知字段仍被拒绝", () => {
    expect(() =>
      parseManifest(manifest({ api_version: 2, backends: [backend], extra: true })),
    ).toThrow(/[Uu]nrecognized|extra/);
  });
});

describe("插件 manifest 的 config_schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["base_url"],
    properties: {
      enabled: { type: "boolean", default: true, description: "总开关" },
      base_url: { type: "string", description: "上游根地址" },
      limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      retry: {
        type: "object",
        additionalProperties: false,
        properties: {
          times: { type: "integer", default: 2 },
        },
        default: {},
      },
    },
  };

  it("没有 config_schema 的旧 manifest 解析结果不变", () => {
    const parsed = parseManifest(manifest());
    expect(parsed).not.toHaveProperty("config_schema");
    expect(parsed).toEqual({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      api_version: 1,
      provides: ["fetch"],
      entry: "index.mjs",
    });
  });

  it("保留合法的 config_schema", () => {
    const parsed = parseManifest(manifest({ config_schema: schema }));
    expect(parsed.config_schema).toEqual(schema);
  });

  it("拒绝未知关键字（$ref / pattern），并带路径", () => {
    const withRef = {
      type: "object",
      properties: { a: { $ref: "#/definitions/x" } },
    };
    expect(() => parseManifest(manifest({ config_schema: withRef }))).toThrow(
      /config_schema\.properties\.a\.\$ref/,
    );

    const withPattern = {
      type: "object",
      properties: { base_url: { type: "string", pattern: "^https://" } },
    };
    expect(() => parseManifest(manifest({ config_schema: withPattern }))).toThrow(
      /config_schema\.properties\.base_url\.pattern/,
    );
  });

  it("拒绝根节点不是 object", () => {
    expect(() =>
      parseManifest(manifest({ config_schema: { type: "string", properties: {} } })),
    ).toThrow(/根节点 type 必须是 "object"/);
    expect(() => parseManifest(manifest({ config_schema: "nope" }))).toThrow(
      /config_schema.*必须是对象/,
    );
  });

  it("拒绝 required 引用不存在的字段", () => {
    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            required: ["missing"],
            properties: { base_url: { type: "string" } },
          },
        }),
      ),
    ).toThrow(/missing.*未在 properties 中声明/);
  });

  it("拒绝 properties 放在非 object、items 放在非 array", () => {
    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            properties: { a: { type: "string", properties: {} } },
          },
        }),
      ),
    ).toThrow(/properties.*只有 type 为 object/);

    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            properties: { a: { type: "string", items: { type: "string" } } },
          },
        }),
      ),
    ).toThrow(/items.*只有 type 为 array/);
  });

  it("拒绝超过深度与节点上限", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i += 1) {
      deep = { type: "object", properties: { child: deep } };
    }
    expect(() => parseManifest(manifest({ config_schema: deep }))).toThrow(
      /深度不能超过 8 层/,
    );

    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`f${index}`, { type: "string" }]),
      ),
    };
    expect(() => parseManifest(manifest({ config_schema: wide }))).toThrow(
      /节点总数不能超过 256/,
    );
  });
});
