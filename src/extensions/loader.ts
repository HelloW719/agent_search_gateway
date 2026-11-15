/** 第三方扩展的运行时加载：扫描 `data/extensions`，按 manifest 读取入口模块。
 *
 * 约定（见 docs/extensions.md）：
 * - 目录名必须等于 `manifest.id`，否则视为坏包；
 * - `api_version` 当前只支持 1；
 * - `provides: ["fetch"]` 读取命名导出 `fetch`，`provides: ["search"]` 读取 `engine`；
 * - 单个插件加载失败只记录 error + warn，不影响网关启动与其它插件。
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineProvider, EngineProviderContext } from "../engines/provider.js";
import type { FetchPlugin, FetchPluginContext } from "../fetch/plugins/types.js";
import type { Logger } from "../logger.js";
import { hasCategory } from "../search/category.js";
import { resolveSecretValue } from "../settings/secret-ref.js";
import { deepFreeze, resolvePluginConfig, type PluginConfig } from "./config.js";
import { extensionsDir } from "./install.js";
import { parseManifest, type ExtensionManifest } from "./manifest.js";

export { extensionsDir };

export interface LoadedExtensions {
  fetch: FetchPlugin[];
  engines: EngineProvider[];
  errors: Array<{ id: string; error: string }>;
}

/** 测试注入点：默认走原生动态 import。 */
export type ExtensionModuleImporter = (url: string) => Promise<unknown>;

export interface LoadExtensionsOptions {
  logger?: Logger;
  importModule?: ExtensionModuleImporter;
  /** gateway.yaml 的 `extensions` 段：routing 按完整 engineId 索引，config 按 manifest id 索引。
   *  CLI 可能传未经 schema 校验的原始值。 */
  extensionConfig?: Record<string, unknown>;
  /** secrets.yaml 的 `extensions` 段：同时兼容完整 engineId 与 manifest id（manifest id 优先）。 */
  extensionSecrets?: Record<string, unknown>;
  /** 解析 `env:NAME` 用的环境变量，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_IMPORT: ExtensionModuleImporter = (url) => import(url);

const MANIFEST_FILE = "asg-plugin.json";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 记录单个插件的加载错误；warn 只影响日志，不中断整轮扫描。 */
function fail(
  result: LoadedExtensions,
  logger: Logger | undefined,
  id: string,
  error: unknown,
): void {
  const message = messageOf(error);
  result.errors.push({ id, error: message });
  logger?.warn(`扩展 ${id} 加载失败：${message}`);
}

/** 用 manifest 覆盖 fetch 插件的身份元数据，函数实现与可选字段原样保留。 */
function toFetchPlugin(manifest: ExtensionManifest, raw: Record<string, unknown>): FetchPlugin {
  if (typeof raw.match !== "function" || typeof raw.fetch !== "function") {
    throw new Error("provides 含 fetch，但入口导出的 fetch 缺少 match / fetch 函数");
  }

  // manifest 的 platform 只作为 fetch 插件的平台回退；插件自身声明优先。
  const platform =
    (nonEmptyString(raw.platform) ? raw.platform : undefined) ??
    manifest.platform ??
    manifest.id;

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((item): item is string => typeof item === "string")
    : [];

  return {
    ...(raw as unknown as FetchPlugin),
    id: manifest.id,
    name: manifest.id,
    displayName: manifest.name,
    platform,
    capabilities,
  };
}

/** 校验 search 插件的最小契约，并补齐调用方依赖的默认元数据。 */
function toEngineProvider(manifest: ExtensionManifest, raw: Record<string, unknown>): EngineProvider {
  for (const key of ["id", "group", "name"] as const) {
    if (!nonEmptyString(raw[key])) {
      throw new Error(`provides 含 search，但入口导出的 engine 缺少 ${key}`);
    }
  }
  const groups = ["searxng", "gateway.reverse_image", "gateway.search"] as const;
  if (!groups.includes(raw.group as (typeof groups)[number])) {
    throw new Error(`provides 含 search，但 engine.group 不合法：${String(raw.group)}`);
  }
  if (!isRecord(raw.runtime)) {
    throw new Error("provides 含 search，但入口导出的 engine 缺少 runtime");
  }

  return {
    ...(raw as unknown as EngineProvider),
    // manifest id 是密钥/配置的规范键前缀；放在 spread 之后，防止入口导出伪造。
    pluginId: manifest.id,
    kind: raw.kind === "searxng" ? "searxng" : "gateway",
    displayName: nonEmptyString(raw.displayName) ? raw.displayName : manifest.name,
    routing: typeof raw.routing === "function" ? (raw.routing as EngineProvider["routing"]) : () => [],
    available:
      typeof raw.available === "function"
        ? (raw.available as EngineProvider["available"])
        : () => true,
    runtime: raw.runtime as unknown as EngineProvider["runtime"],
  };
}

interface ExtensionRouting {
  category?: string;
  /** 类别名的原样值；匹配时由 hasCategory 负责大小写与逗号分隔。 */
  hotCategory?: string;
}

/** 按 key 取 `extensions` 段里的条目；非对象一律忽略（CLI 可能传未校验值）。
 *
 * routing 用完整 engineId 作 key，config / secrets 还额外支持 manifest id。
 */
function extensionEntry(value: unknown, engineId: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[engineId];
  return isRecord(entry) ? entry : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 读取路由覆盖；只接受非空字符串，其余字段忽略。 */
function routingOf(entry: Record<string, unknown> | undefined): ExtensionRouting {
  const routing = isRecord(entry?.routing) ? entry.routing : {};
  return {
    category: trimmedString(routing.category),
    hotCategory: trimmedString(routing.hot_category),
  };
}

/** 把扩展密钥解析成插件可见的扁平 map；空值不注入。 */
function pluginSecretsOf(
  entry: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!entry) return out;
  for (const [name, raw] of Object.entries(entry)) {
    if (typeof raw !== "string") continue;
    const value = resolveSecretValue(raw, env);
    if (value.trim().length > 0) out[name] = value;
  }
  return out;
}

/** 合并 `extensions.<engineId>` 与 `extensions.<manifest id>` 两个密钥段。
 *
 * manifest id 是新的规范键，优先级高于 engineId（旧的 engineId 键继续兼容）。
 * 解析后仍为空的值不注入，因此空值不会清掉旧键里已有的非空值。
 */
function mergePluginSecrets(
  options: LoadExtensionsOptions,
  engineId: string | undefined,
  manifestId: string,
): Record<string, string> {
  const env = options.env ?? process.env;
  const legacy =
    engineId === undefined
      ? {}
      : pluginSecretsOf(extensionEntry(options.extensionSecrets, engineId), env);
  const current = pluginSecretsOf(extensionEntry(options.extensionSecrets, manifestId), env);
  return deepFreeze({ ...legacy, ...current });
}

/**
 * 用 gateway.yaml / secrets.yaml 的 `extensions` 段包装插件 provider。
 *
 * 只在确有配置（路由 / 密钥 / `secret:` 依赖 / 私有 config）时包装；未配置的插件保持原对象，
 * 运行期与 CLI 的行为完全不变。
 */
function withExtensionOptions(
  provider: EngineProvider,
  pluginSecrets: Record<string, string>,
  routing: ExtensionRouting,
  pluginConfig: PluginConfig,
  hasConfig: boolean,
): EngineProvider {
  const hasRouting = routing.category !== undefined || routing.hotCategory !== undefined;
  const requiredSecrets = (provider.requires ?? []).filter((item) =>
    item.startsWith("secret:"),
  );

  const augment = (ctx: EngineProviderContext): EngineProviderContext => {
    const hasSecrets = Object.keys(pluginSecrets).length > 0;
    if (!hasConfig && !hasSecrets) return ctx;
    return {
      ...ctx,
      ...(hasConfig ? { pluginConfig } : {}),
      ...(hasSecrets ? { pluginSecrets } : {}),
    };
  };

  const routingList = (): string[] => {
    const list: string[] = [];
    if (routing.category) list.push(`category:${routing.category}`);
    if (routing.hotCategory) list.push(`category:${routing.hotCategory}`);
    return list;
  };

  const plan = (categories: string | undefined): { hot: boolean } | undefined => {
    if (routing.hotCategory && hasCategory(categories, routing.hotCategory)) return { hot: true };
    if (routing.category && hasCategory(categories, routing.category)) return { hot: false };
    return undefined;
  };

  const runtime = provider.runtime;
  let wrappedRuntime = runtime;
  if (runtime?.kind === "reverse_image") {
    wrappedRuntime = {
      kind: "reverse_image",
      search: (input, ctx) => runtime.search(input, augment(ctx)),
    };
  } else if (runtime?.kind === "search") {
    wrappedRuntime = {
      kind: "search",
      plan: (categories, ctx) =>
        hasRouting ? plan(categories) : runtime.plan(categories, augment(ctx)),
      search: (query, searchOptions, ctx) => runtime.search(query, searchOptions, augment(ctx)),
    };
  }

  return {
    ...provider,
    routing: (ctx) => (hasRouting ? routingList() : provider.routing(augment(ctx))),
    available: (ctx) => {
      if (!provider.available(augment(ctx))) return false;
      return requiredSecrets.every((item) => {
        const name = item.slice("secret:".length);
        return (pluginSecrets[name] ?? "").trim().length > 0;
      });
    },
    enabled: provider.enabled ? (ctx) => provider.enabled!(augment(ctx)) : undefined,
    runtime: wrappedRuntime,
  };
}

/** 按 engineId 读路由，再把调用方解析好的密钥/私有配置注入 provider。 */
function applyExtensionOptions(
  provider: EngineProvider,
  options: LoadExtensionsOptions,
  pluginConfig: PluginConfig,
  pluginSecrets: Record<string, string>,
  hasConfig: boolean,
): EngineProvider {
  // routing 仍只认 `extensions.<engineId>.routing`；config 的键是 manifest id（由调用方解析）。
  const configEntry = extensionEntry(options.extensionConfig, provider.id);
  // 路由覆盖只对类别分流的文本源有意义；图搜源的 routing 固定为 source。
  const routing = provider.group === "gateway.search" ? routingOf(configEntry) : {};
  const hasRouting = routing.category !== undefined || routing.hotCategory !== undefined;
  const hasSecretRequirement = (provider.requires ?? []).some((item) =>
    item.startsWith("secret:"),
  );

  if (
    !hasRouting &&
    !hasSecretRequirement &&
    !hasConfig &&
    Object.keys(pluginSecrets).length === 0
  ) {
    return provider;
  }

  return withExtensionOptions(provider, pluginSecrets, routing, pluginConfig, hasConfig);
}

/**
 * 用 `extensions` 段包装 fetch 插件：只增强 `enabled` / `available` / `fetch`。
 *
 * `match(url)` 保持原函数原样（契约要求它只读 URL、不读配置）；
 * 没有 `enabled` / `available` 时不凭空补一个。
 */
function withFetchOptions(
  plugin: FetchPlugin,
  pluginConfig: PluginConfig,
  pluginSecrets: Record<string, string>,
  hasConfig: boolean,
): FetchPlugin {
  const hasSecrets = Object.keys(pluginSecrets).length > 0;
  if (!hasConfig && !hasSecrets) return plugin;

  const augment = (ctx: FetchPluginContext): FetchPluginContext => ({
    ...ctx,
    ...(hasConfig ? { pluginConfig } : {}),
    ...(hasSecrets ? { pluginSecrets } : {}),
  });

  const enabled = plugin.enabled;
  const available = plugin.available;

  return {
    ...plugin,
    ...(enabled ? { enabled: (ctx: FetchPluginContext) => enabled(augment(ctx)) } : {}),
    ...(available ? { available: (ctx: FetchPluginContext) => available(augment(ctx)) } : {}),
    fetch: (url: URL, ctx: FetchPluginContext) => plugin.fetch(url, augment(ctx)),
  };
}

/**
 * 扫描并加载 `<root>/data/extensions` 下的全部插件。
 *
 * 扩展目录不存在时返回空结果；任何单个插件的问题都只进入 `errors`。
 */
export async function loadExtensions(
  root: string,
  opts: LoadExtensionsOptions = {},
): Promise<LoadedExtensions> {
  const { logger } = opts;
  const importModule = opts.importModule ?? DEFAULT_IMPORT;
  const result: LoadedExtensions = { fetch: [], engines: [], errors: [] };
  const baseDir = extensionsDir(root);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    fail(result, logger, "extensions", error);
    return result;
  }

  // 排序保证错误与注册顺序稳定（import 顺序不影响已安装集合）。
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const dirName = entry.name;
    const dir = path.join(baseDir, dirName);

    let text: string;
    try {
      text = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      fail(
        result,
        logger,
        dirName,
        code === "ENOENT" ? `未找到 ${MANIFEST_FILE}` : `无法读取 ${MANIFEST_FILE}：${messageOf(error)}`,
      );
      continue;
    }

    let manifest: ExtensionManifest;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      fail(result, logger, dirName, error);
      continue;
    }

    if (manifest.id !== dirName) {
      fail(result, logger, dirName, `目录名 ${dirName} 与 manifest.id ${manifest.id} 不一致`);
      continue;
    }
    if (manifest.api_version !== 1) {
      fail(result, logger, dirName, `不支持的 api_version：${String(manifest.api_version)}（当前只支持 1）`);
      continue;
    }

    // config 的键是 manifest id（不是 engineId）；校验失败时整包跳过。
    const rawConfig = extensionEntry(opts.extensionConfig, manifest.id)?.config;
    const resolved = resolvePluginConfig(manifest.config_schema, rawConfig);
    if (!resolved.ok) {
      fail(result, logger, manifest.id, `插件配置无效：${resolved.error}`);
      continue;
    }
    // settings 经 zod 后 config 默认是 {}；空对象不算“配置”，避免无谓包装与注入。
    const hasConfig =
      manifest.config_schema !== undefined ||
      (isRecord(rawConfig) && Object.keys(rawConfig).length > 0);
    const pluginConfig = deepFreeze(resolved.value);

    let mod: unknown;
    try {
      mod = await importModule(pathToFileURL(path.join(dir, manifest.entry)).href);
    } catch (error) {
      fail(result, logger, manifest.id, `导入 ${manifest.entry} 失败：${messageOf(error)}`);
      continue;
    }
    if (!isRecord(mod)) {
      fail(result, logger, manifest.id, "入口模块没有可用的命名导出");
      continue;
    }

    // 密钥兼容旧的 engineId 键；只有 search 插件能提供 engineId，fetch-only 默认只认 manifest id。
    const engineId =
      isRecord(mod.engine) && nonEmptyString(mod.engine.id) ? mod.engine.id : undefined;
    const pluginSecrets = mergePluginSecrets(opts, engineId, manifest.id);

    if (manifest.provides.includes("fetch")) {
      if (!isRecord(mod.fetch)) {
        fail(result, logger, manifest.id, "入口未导出 fetch 对象");
      } else if (result.fetch.some((plugin) => plugin.id === manifest.id)) {
        fail(result, logger, manifest.id, `fetch 插件 id 重复：${manifest.id}`);
      } else {
        try {
          const plugin = toFetchPlugin(manifest, mod.fetch);
          result.fetch.push(withFetchOptions(plugin, pluginConfig, pluginSecrets, hasConfig));
        } catch (error) {
          fail(result, logger, manifest.id, error);
        }
      }
    }

    if (manifest.provides.includes("search")) {
      if (!isRecord(mod.engine)) {
        fail(result, logger, manifest.id, "入口未导出 engine 对象");
      } else {
        try {
          const provider = applyExtensionOptions(
            toEngineProvider(manifest, mod.engine),
            opts,
            pluginConfig,
            pluginSecrets,
            hasConfig,
          );
          if (result.engines.some((item) => item.id === provider.id)) {
            fail(result, logger, manifest.id, `search 插件 id 重复：${provider.id}`);
          } else {
            result.engines.push(provider);
          }
        } catch (error) {
          fail(result, logger, manifest.id, error);
        }
      }
    }
  }

  return result;
}
