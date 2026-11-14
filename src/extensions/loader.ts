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
import type { EngineProvider } from "../engines/provider.js";
import type { FetchPlugin } from "../fetch/plugins/types.js";
import type { Logger } from "../logger.js";
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

    if (manifest.provides.includes("fetch")) {
      if (!isRecord(mod.fetch)) {
        fail(result, logger, manifest.id, "入口未导出 fetch 对象");
      } else if (result.fetch.some((plugin) => plugin.id === manifest.id)) {
        fail(result, logger, manifest.id, `fetch 插件 id 重复：${manifest.id}`);
      } else {
        try {
          result.fetch.push(toFetchPlugin(manifest, mod.fetch));
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
          const provider = toEngineProvider(manifest, mod.engine);
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
