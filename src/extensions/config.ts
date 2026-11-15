/** 第三方插件私有配置（manifest.config_schema + gateway.yaml 的 config 段）。
 *
 * 这里只做底层能力：校验 `config_schema` 定义、编译成 zod schema、补默认值、
 * 校验用户配置、输出字段描述。loader / CLI / 文档不在本模块职责内。
 *
 * 支持的 JSON Schema 子集刻意收窄（见 ADR 与 manifest 文档）：
 * 只接受 type/description/default/enum/minimum/maximum/minLength/maxLength/
 * items/properties/required/additionalProperties；其他关键字一律报错，
 * 避免插件作者误以为 `$ref`、`pattern`、`oneOf` 等会生效。
 */

import { z } from "zod";

export type PluginConfig = Record<string, unknown>;

export interface ConfigFieldInfo {
  /** 顶层字段名。 */
  key: string;
  /** object/string/integer/...；未声明 type 时为 `any`。 */
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
}

export type ConfigValidation =
  | { ok: true; value: PluginConfig }
  | { ok: false; error: string };

/** 允许在每个 schema 节点上出现的关键字。 */
const ALLOWED_KEYWORDS = new Set([
  "type",
  "description",
  "default",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

const ALLOWED_TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);

/** 递归深度上限（根节点算第 1 层）。 */
const MAX_DEPTH = 8;
/** schema 节点总数上限（含根、properties/items/additionalProperties 子节点）。 */
const MAX_NODES = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at =
        issue.path.length > 0
          ? issue.path
              .map((segment, index) => {
                if (typeof segment === "number") return `[${segment}]`;
                const key = String(segment);
                return index === 0 ? key : `.${key}`;
              })
              .join("")
          : "(根)";
      return `${at}: ${issue.message}`;
    })
    .join("；");
}

function nodePath(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${key}`;
}

/**
 * 校验 `config_schema` 定义本身；不合法抛 Error（中文、带路径）。
 *
 * 错误路径以 `config_schema` 为根，例如 `config_schema.properties.limit: ...`。
 */
export function validateConfigSchemaDefinition(
  schema: unknown,
): asserts schema is Record<string, unknown> {
  if (!isPlainObject(schema)) {
    throw new Error("config_schema: 配置 schema 必须是对象");
  }

  if (schema.type !== "object") {
    throw new Error('config_schema.type: 根节点 type 必须是 "object"');
  }
  if (!isPlainObject(schema.properties)) {
    throw new Error("config_schema.properties: 根节点必须声明 properties 对象（可以是空对象）");
  }

  const state = { nodes: 0 };
  validateNode(schema, "config_schema", 1, state);
}

function validateNode(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (depth > MAX_DEPTH) {
    throw new Error(`${path}: 嵌套深度不能超过 ${MAX_DEPTH} 层`);
  }
  if (state.nodes > MAX_NODES) {
    throw new Error(`${path}: 节点总数不能超过 ${MAX_NODES} 个`);
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`${nodePath(path, key)}: 不支持的 JSON Schema 关键字 "${key}"`);
    }
  }

  const type = node.type;
  if (type !== undefined && (typeof type !== "string" || !ALLOWED_TYPES.has(type))) {
    throw new Error(
      `${nodePath(path, "type")}: 必须是 ${[...ALLOWED_TYPES].join("/")} 之一`,
    );
  }

  if (node.description !== undefined && typeof node.description !== "string") {
    throw new Error(`${nodePath(path, "description")}: 必须是字符串`);
  }

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      throw new Error(`${nodePath(path, "enum")}: 必须是非空数组`);
    }
    node.enum.forEach((item, index) => {
      const itemType = typeof item;
      if (itemType !== "string" && itemType !== "number" && itemType !== "boolean") {
        throw new Error(
          `${nodePath(nodePath(path, "enum"), index)}: 只能是字符串、数字或布尔值`,
        );
      }
    });
  }

  for (const key of ["minimum", "maximum"] as const) {
    const value = node[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${nodePath(path, key)}: 必须是有限数字`);
    }
  }

  for (const key of ["minLength", "maxLength"] as const) {
    const value = node[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`${nodePath(path, key)}: 必须是非负整数`);
    }
  }

  if (node.properties !== undefined) {
    if (type !== "object") {
      throw new Error(
        `${nodePath(path, "properties")}: 只有 type 为 object 的节点可以声明 properties`,
      );
    }
    if (!isPlainObject(node.properties)) {
      throw new Error(`${nodePath(path, "properties")}: 必须是对象`);
    }
    for (const [name, child] of Object.entries(node.properties)) {
      if (!isPlainObject(child)) {
        throw new Error(`${nodePath(nodePath(path, "properties"), name)}: 节点必须是对象`);
      }
      validateNode(child, nodePath(nodePath(path, "properties"), name), depth + 1, state);
    }
  }

  if (node.required !== undefined) {
    if (type !== "object") {
      throw new Error(
        `${nodePath(path, "required")}: 只有 type 为 object 的节点可以声明 required`,
      );
    }
    if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== "string")) {
      throw new Error(`${nodePath(path, "required")}: 必须是字符串数组`);
    }
    const properties = isPlainObject(node.properties) ? node.properties : {};
    for (const name of node.required) {
      if (!Object.hasOwn(properties, name)) {
        throw new Error(
          `${nodePath(path, "required")}: 字段 "${name}" 未在 properties 中声明`,
        );
      }
    }
  }

  if (node.items !== undefined) {
    if (type !== "array") {
      throw new Error(
        `${nodePath(path, "items")}: 只有 type 为 array 的节点可以声明 items`,
      );
    }
    if (!isPlainObject(node.items)) {
      throw new Error(`${nodePath(path, "items")}: 必须是对象`);
    }
    validateNode(node.items, nodePath(path, "items"), depth + 1, state);
  }

  if (node.additionalProperties !== undefined) {
    const extra = node.additionalProperties;
    if (typeof extra === "boolean") {
      // ok
    } else if (isPlainObject(extra)) {
      validateNode(
        extra,
        nodePath(path, "additionalProperties"),
        depth + 1,
        state,
      );
    } else {
      throw new Error(`${nodePath(path, "additionalProperties")}: 只能是布尔值或子 schema 对象`);
    }
  }
}

/** 深拷贝 schema，并把省略的 additionalProperties 递归补成 false（不修改入参）。 */
function normalizeSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...node };

  if (isPlainObject(copy.properties)) {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([name, child]) => [
        name,
        isPlainObject(child) ? normalizeSchemaNode(child) : child,
      ]),
    );
  }
  if (isPlainObject(copy.items)) {
    copy.items = normalizeSchemaNode(copy.items);
  }
  if (isPlainObject(copy.additionalProperties)) {
    copy.additionalProperties = normalizeSchemaNode(copy.additionalProperties);
  }

  // 只对 object 节点补默认值；省略时按 false（拒绝拼写错误）。
  if (copy.type === "object" && copy.additionalProperties === undefined) {
    copy.additionalProperties = false;
  }

  return copy;
}

/** 递归校验每个节点上的 default 是否能通过该节点自身的 schema。 */
function assertDefaultsValid(node: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(node, "default")) {
    const probe: Record<string, unknown> = { ...node };
    delete probe.default;
    delete probe.description;
    const result = z.fromJSONSchema(probe).safeParse(node.default);
    if (!result.success) {
      throw new Error(`${nodePath(path, "default")}: 默认值不合法：${formatIssues(result.error)}`);
    }
  }

  if (isPlainObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      if (isPlainObject(child)) {
        assertDefaultsValid(child, nodePath(nodePath(path, "properties"), name));
      }
    }
  }
  if (isPlainObject(node.items)) {
    assertDefaultsValid(node.items, nodePath(path, "items"));
  }
  if (isPlainObject(node.additionalProperties)) {
    assertDefaultsValid(node.additionalProperties, nodePath(path, "additionalProperties"));
  }
}

/** 用 z.fromJSONSchema 编译；默认值由 zod 自动补齐。 */
export function compilePluginConfigSchema(
  schema: Record<string, unknown>,
): z.ZodType<PluginConfig> {
  const normalized = normalizeSchemaNode(schema);
  assertDefaultsValid(normalized, "config_schema");
  return z.fromJSONSchema(normalized) as unknown as z.ZodType<PluginConfig>;
}

/** 递归补齐「父节点 default 里的空对象」遗漏的子字段默认值。
 *
 * z.fromJSONSchema 在父节点整块缺省时只套用父节点 default，不会继续深入；
 * 这里按 schema 再走一遍，保证嵌套对象的子字段默认值同样生效。
 */
function applyDefaults(schema: unknown, value: unknown): unknown {
  if (!isPlainObject(schema)) return value;

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    return value.map((item) => applyDefaults(schema.items, item));
  }
  if (!isPlainObject(value)) return value;

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = { ...value };

  for (const [key, child] of Object.entries(properties)) {
    if (!isPlainObject(child)) continue;
    if (!Object.hasOwn(out, key)) {
      if (Object.hasOwn(child, "default")) {
        out[key] = applyDefaults(child, structuredClone(child.default));
      }
      continue;
    }
    out[key] = applyDefaults(child, out[key]);
  }

  return out;
}

/**
 * 校验并补默认值。
 * - schema 为 undefined：raw 必须是对象或 undefined，按原样深拷贝返回（缺省 {}）。
 * - schema 存在：raw 缺省为 {}，补默认值、拒绝未知键/类型错误。
 * - 返回值始终是调用方独占的普通对象；调用方可安全 `deepFreeze`，不会冻结入参。
 */
export function resolvePluginConfig(
  schema: Record<string, unknown> | undefined,
  raw: unknown,
): ConfigValidation {
  if (schema === undefined) {
    if (raw === undefined) return { ok: true, value: {} };
    if (!isPlainObject(raw)) {
      return { ok: false, error: "(根): 插件配置必须是对象" };
    }
    return { ok: true, value: structuredClone(raw) };
  }

  if (raw !== undefined && !isPlainObject(raw)) {
    return { ok: false, error: "(根): 插件配置必须是对象" };
  }

  let compiled: z.ZodType<PluginConfig>;
  try {
    validateConfigSchemaDefinition(schema);
    compiled = compilePluginConfigSchema(schema);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const result = compiled.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, error: formatIssues(result.error) };
  }

  const value = applyDefaults(schema, result.data);
  return { ok: true, value: value as PluginConfig };
}

/** 顶层字段描述，供 CLI --describe 使用；schema 缺省返回 []。 */
export function describePluginConfig(
  schema: Record<string, unknown> | undefined,
): ConfigFieldInfo[] {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );

  const fields: ConfigFieldInfo[] = [];
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!isPlainObject(child)) continue;
    const info: ConfigFieldInfo = {
      key,
      type: typeof child.type === "string" ? child.type : "any",
      required: required.has(key),
    };
    if (Object.hasOwn(child, "default")) info.default = child.default;
    if (typeof child.description === "string") info.description = child.description;
    fields.push(info);
  }
  return fields;
}

/** 递归冻结对象/数组；非对象原样返回。 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (target: unknown): void => {
    if (typeof target !== "object" || target === null) return;
    if (seen.has(target)) return;
    seen.add(target);
    Object.freeze(target);
    for (const key of Object.keys(target)) {
      freeze((target as Record<string, unknown>)[key]);
    }
  };
  freeze(value);
  return value;
}
