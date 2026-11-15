import { describe, expect, it } from "vitest";
import {
  compilePluginConfigSchema,
  deepFreeze,
  describePluginConfig,
  resolvePluginConfig,
  validateConfigSchemaDefinition,
} from "../../src/extensions/config.js";

/** 与协议文档示例一致的配置 schema。 */
function configSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["base_url"],
    properties: {
      enabled: { type: "boolean", default: true, description: "总开关" },
      base_url: { type: "string", description: "上游根地址" },
      timeout_ms: { type: "integer", default: 10000, minimum: 1000 },
      limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      mode: { type: "string", enum: ["fast", "full"], default: "fast" },
      languages: { type: "array", items: { type: "string" }, default: ["zh"] },
      retry: {
        type: "object",
        additionalProperties: false,
        properties: {
          times: { type: "integer", default: 2, minimum: 0, maximum: 5 },
          backoff_ms: { type: "integer", default: 500 },
        },
        default: {},
      },
    },
  };
}

function expectOk(result: ReturnType<typeof resolvePluginConfig>) {
  if (!result.ok) throw new Error(`预期成功，实际失败：${result.error}`);
  return result.value;
}

function expectError(result: ReturnType<typeof resolvePluginConfig>): string {
  if (result.ok) throw new Error("预期失败，实际成功");
  return result.error;
}

describe("validateConfigSchemaDefinition", () => {
  it("接受示例 schema，且不修改入参", () => {
    const schema = configSchema();
    const before = structuredClone(schema);
    expect(() => validateConfigSchemaDefinition(schema)).not.toThrow();
    expect(schema).toEqual(before);
  });

  it("接受没有 properties 子节点的空对象根", () => {
    expect(() =>
      validateConfigSchemaDefinition({ type: "object", properties: {} }),
    ).not.toThrow();
  });

  it("拒绝未知关键字，并带路径", () => {
    const schema = configSchema();
    (schema.properties as Record<string, unknown>).base_url = {
      type: "string",
      pattern: "^https://",
    };
    expect(() => validateConfigSchemaDefinition(schema)).toThrow(
      /config_schema\.properties\.base_url\.pattern/,
    );

    const ref = { type: "object", properties: { a: { $ref: "#/x" } } };
    expect(() => validateConfigSchemaDefinition(ref)).toThrow(/config_schema\.properties\.a\.\$ref/);
  });

  it("拒绝根节点不是 object / 缺少 properties", () => {
    expect(() => validateConfigSchemaDefinition({ type: "string" })).toThrow(
      /根节点 type 必须是 "object"/,
    );
    expect(() => validateConfigSchemaDefinition({ type: "object" })).toThrow(
      /root|properties/i,
    );
  });

  it("拒绝 properties 出现在非 object 节点", () => {
    expect(() =>
      validateConfigSchemaDefinition({
        type: "object",
        properties: { a: { type: "string", properties: { b: { type: "string" } } } },
      }),
    ).toThrow(/properties.*只有 type 为 object/);
  });

  it("拒绝 items 出现在非 array 节点", () => {
    expect(() =>
      validateConfigSchemaDefinition({
        type: "object",
        properties: { a: { type: "string", items: { type: "string" } } },
      }),
    ).toThrow(/items.*只有 type 为 array/);
  });

  it("拒绝 required 引用不存在的字段", () => {
    expect(() =>
      validateConfigSchemaDefinition({
        type: "object",
        required: ["base_url"],
        properties: { enabled: { type: "boolean" } },
      }),
    ).toThrow(/base_url.*未在 properties 中声明/);
  });

  it("拒绝非法的 enum / additionalProperties / type", () => {
    const build = (child: Record<string, unknown>) => ({
      type: "object",
      properties: { a: child },
    });
    expect(() => validateConfigSchemaDefinition(build({ type: "string", enum: [] }))).toThrow(
      /enum.*非空/,
    );
    expect(() => validateConfigSchemaDefinition(build({ type: "string", enum: [null] }))).toThrow(
      /enum\[0\].*字符串、数字或布尔值/,
    );
    expect(() =>
      validateConfigSchemaDefinition(build({ type: "object", additionalProperties: "yes" })),
    ).toThrow(/additionalProperties.*布尔值/);
    expect(() => validateConfigSchemaDefinition(build({ type: "null" }))).toThrow(/type/);
  });

  it("拒绝超过深度上限（8 层）", () => {
    const nested = (depth: number) => {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = depth - 1; i >= 1; i -= 1) {
        node = { type: "object", properties: { child: node } };
      }
      return node;
    };
    expect(() => validateConfigSchemaDefinition(nested(8))).not.toThrow();
    expect(() => validateConfigSchemaDefinition(nested(9))).toThrow(/深度不能超过 8 层/);
  });

  it("拒绝超过节点总数上限（256）", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`f${index}`, { type: "string" }]),
    );
    expect(() => validateConfigSchemaDefinition({ type: "object", properties })).toThrow(
      /节点总数不能超过 256/,
    );
  });
});

describe("compilePluginConfigSchema", () => {
  it("省略 additionalProperties 时按 false 处理", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const compiled = compilePluginConfigSchema(schema);
    expect(compiled.safeParse({ a: "x" }).success).toBe(true);
    expect(compiled.safeParse({ a: "x", extra: 1 }).success).toBe(false);
  });

  it("拒绝不合法的 default", () => {
    expect(() =>
      compilePluginConfigSchema({
        type: "object",
        properties: { a: { type: "integer", maximum: 3, default: 9 } },
      }),
    ).toThrow(/default.*默认值不合法/);
  });
});

describe("resolvePluginConfig", () => {
  it("补全嵌套默认值（对象、数组、enum）", () => {
    const value = expectOk(resolvePluginConfig(configSchema(), { base_url: "https://api" }));
    expect(value).toEqual({
      enabled: true,
      base_url: "https://api",
      timeout_ms: 10000,
      limit: 10,
      mode: "fast",
      languages: ["zh"],
      retry: { times: 2, backoff_ms: 500 },
    });
  });

  it("用户值覆盖默认值", () => {
    const value = expectOk(
      resolvePluginConfig(configSchema(), {
        base_url: "https://api",
        enabled: false,
        limit: 5,
        mode: "full",
        languages: ["zh", "en"],
        retry: { times: 4 },
      }),
    );
    expect(value.enabled).toBe(false);
    expect(value.limit).toBe(5);
    expect(value.mode).toBe("full");
    expect(value.languages).toEqual(["zh", "en"]);
    expect(value.retry).toEqual({ times: 4, backoff_ms: 500 });
  });

  it("拒绝未知键，并带字段名", () => {
    const message = expectError(
      resolvePluginConfig(configSchema(), { base_url: "https://api", typo: 1 }),
    );
    expect(message).toContain("typo");

    const nested = expectError(
      resolvePluginConfig(configSchema(), { base_url: "https://api", retry: { wrong: 1 } }),
    );
    expect(nested).toContain("wrong");
  });

  it("类型 / 范围 / 枚举错误带字段路径", () => {
    expect(
      expectError(resolvePluginConfig(configSchema(), { base_url: "https://api", limit: 100 })),
    ).toMatch(/^limit: /);
    expect(
      expectError(resolvePluginConfig(configSchema(), { base_url: "https://api", limit: 0 })),
    ).toMatch(/^limit: /);
    expect(
      expectError(resolvePluginConfig(configSchema(), { base_url: "https://api", mode: "slow" })),
    ).toMatch(/^mode: /);
    expect(expectError(resolvePluginConfig(configSchema(), { base_url: 1 }))).toMatch(
      /^base_url: /,
    );
    expect(
      expectError(resolvePluginConfig(configSchema(), { base_url: "https://api", timeout_ms: "x" })),
    ).toMatch(/^timeout_ms: /);
    expect(
      expectError(
        resolvePluginConfig(configSchema(), { base_url: "https://api", languages: ["zh", 1] }),
      ),
    ).toMatch(/^languages\[1\]: /);
  });

  it("required 缺失时报错", () => {
    expect(expectError(resolvePluginConfig(configSchema(), {}))).toMatch(/^base_url: /);
  });

  it("没有 schema 时按原样深拷贝透传；raw 不是对象时报错", () => {
    const raw = { any: "thing", nested: { x: 1 } };
    const result = resolvePluginConfig(undefined, raw);
    expect(result).toEqual({ ok: true, value: raw });
    if (result.ok) {
      expect(result.value).not.toBe(raw);
      expect(result.value).toEqual(raw);
    }

    expect(resolvePluginConfig(undefined, undefined)).toEqual({ ok: true, value: {} });
    expect(expectError(resolvePluginConfig(undefined, "scalar"))).toContain("必须是对象");
    expect(expectError(resolvePluginConfig(undefined, [1, 2]))).toContain("必须是对象");
    expect(expectError(resolvePluginConfig(undefined, null))).toContain("必须是对象");
  });

  it("冻结无 schema 的返回值不会影响原始 raw", () => {
    const raw = { nested: { x: 1 }, list: [{ y: 2 }] };
    const result = resolvePluginConfig(undefined, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    deepFreeze(result.value);

    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.nested)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.nested)).toBe(false);
    expect(Object.isFrozen(raw.list[0])).toBe(false);

    raw.nested.x = 9;
    raw.list[0]!.y = 9;
    expect(raw).toEqual({ nested: { x: 9 }, list: [{ y: 9 }] });
    expect(result.value).toEqual({ nested: { x: 1 }, list: [{ y: 2 }] });
  });

  it("schema 存在时 raw 不是对象也报错", () => {
    expect(expectError(resolvePluginConfig(configSchema(), [1]))).toContain("必须是对象");
    expect(expectError(resolvePluginConfig(configSchema(), 42))).toContain("必须是对象");
  });

  it("schema 定义非法时返回错误而不是抛异常", () => {
    const bad = { type: "object", properties: { a: { type: "string", pattern: "x" } } };
    const result = resolvePluginConfig(bad, {});
    expect(result.ok).toBe(false);
    expect(expectError(result)).toContain("pattern");
  });
});

describe("describePluginConfig", () => {
  it("输出顶层字段的类型、默认值、必填与描述", () => {
    const fields = describePluginConfig(configSchema());
    expect(fields).toEqual([
      { key: "enabled", type: "boolean", required: false, default: true, description: "总开关" },
      { key: "base_url", type: "string", required: true, description: "上游根地址" },
      { key: "timeout_ms", type: "integer", required: false, default: 10000 },
      { key: "limit", type: "integer", required: false, default: 10 },
      { key: "mode", type: "string", required: false, default: "fast" },
      { key: "languages", type: "array", required: false, default: ["zh"] },
      { key: "retry", type: "object", required: false, default: {} },
    ]);
  });

  it("缺省 schema 或字段没有 type 时的兜底", () => {
    expect(describePluginConfig(undefined)).toEqual([]);
    expect(
      describePluginConfig({ type: "object", properties: { anything: {} } }),
    ).toEqual([{ key: "anything", type: "any", required: false }]);
  });
});

describe("deepFreeze", () => {
  it("冻结嵌套对象与数组，非对象原样返回", () => {
    const value = deepFreeze({ a: { b: 1 }, list: [{ c: 2 }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);

    expect(() => {
      (value.a as { b: number }).b = 3;
    }).toThrow(TypeError);
    expect(() => {
      (value.list as unknown[]).push({ c: 3 });
    }).toThrow(TypeError);

    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze("x")).toBe("x");
    expect(deepFreeze(null)).toBe(null);

    const resolved = expectOk(resolvePluginConfig(configSchema(), { base_url: "https://api" }));
    const frozen = deepFreeze(resolved);
    expect(Object.isFrozen(frozen.retry)).toBe(true);
    expect(() => {
      (frozen.retry as { times: number }).times = 9;
    }).toThrow(TypeError);
  });
});
