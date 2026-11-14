/**
 * 取件插件注册表默认实例。
 *
 * `directFetch` 入口先查此表：命中即交给插件（跳过 SSRF 与 generic 重定向链），
 * 未命中才走通用抓取。新增内置插件时只在这里注册，核心路径不改。
 * 当前注册：`cnki`（知网取件，见 ADR-0009）、`bilibili`（B 站视频/专栏自动摘要）、
 * `weibo`（微博取件，单 CLI 后端 OpenCLI + 图片 CDN 自动匹配）。
 */
import { bilibiliPlugin } from "../../bilibili/index.js";
import { weiboPlugin } from "../../weibo/index.js";
import { cnkiPlugin } from "./cnki.js";
import { createFetchPluginRegistry, type FetchPluginRegistry } from "./registry.js";
import type { FetchPlugin, FetchPluginContext } from "./types.js";

export type {
  FetchPlugin,
  FetchPluginContext,
  FetchPluginRequirement,
  FetchPluginResult,
} from "./types.js";

/** 内置抓取插件：外部插件同 id 时由 `createFetchRegistry` 覆盖。 */
export const builtinPlugins: readonly FetchPlugin[] = [cnkiPlugin, bilibiliPlugin, weiboPlugin];

export const fetchPluginRegistry = createFetchPluginRegistry(builtinPlugins);

/**
 * 按 id 合并内置与外部插件：外部同 id 原位覆盖内置，新增 id 按加载顺序追加，
 * 最终再交给 `createFetchPluginRegistry` 做重复校验。
 */
export function createFetchRegistry(external: readonly FetchPlugin[]): FetchPluginRegistry {
  const externalById = new Map<string, FetchPlugin>();
  for (const plugin of external) {
    if (externalById.has(plugin.id)) throw new Error(`重复的抓取插件 id: ${plugin.id}`);
    externalById.set(plugin.id, plugin);
  }

  const merged: FetchPlugin[] = builtinPlugins.map(
    (plugin) => externalById.get(plugin.id) ?? plugin,
  );
  const builtinIds = new Set(builtinPlugins.map((plugin) => plugin.id));
  for (const plugin of external) {
    if (!builtinIds.has(plugin.id)) merged.push(plugin);
  }
  return createFetchPluginRegistry(merged);
}

/** 返回接管该 URL 的插件（已统一过滤 `enabled`，按注册顺序取第一个命中者）。 */
export function findPlugin(url: URL, ctx: FetchPluginContext): FetchPlugin | undefined {
  return fetchPluginRegistry.find(url, ctx);
}

/** 已注册插件的规范 ID（供 health / 日志使用）。 */
export function registeredPlugins(): string[] {
  return fetchPluginRegistry.list().map((plugin) => plugin.id);
}
