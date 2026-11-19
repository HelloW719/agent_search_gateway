/** 扩展数据目录、后端路径与后端状态读取。
 *
 * setup 宿主、CLI 与运行时 loader 共用同一套布局：
 * `data/extension-data/<id>/backends/<backend-id>/`。
 */

import fs from "node:fs";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 插件可写数据目录：`data/extension-data/<id>`。 */
export function extensionDataDir(root: string, extensionId: string): string {
  return path.join(root, "data", "extension-data", extensionId);
}

/** setup 宿主写入的后端状态文件：`data/extension-data/<id>/backends.json`。 */
export function backendStateFile(root: string, extensionId: string): string {
  return path.join(extensionDataDir(root, extensionId), "backends.json");
}

/** 单个后端的安装目录：`data/extension-data/<id>/backends/<backendId>`。 */
export function backendInstallDir(
  root: string,
  extensionId: string,
  backendId: string,
): string {
  return path.join(extensionDataDir(root, extensionId), "backends", backendId);
}

export interface BackendStateRead {
  states: Record<string, unknown>;
  /** 状态文件不可读/损坏时的告警；调用方决定如何展示。 */
  warning?: string;
}

/** 只读状态文件；缺失视为空，损坏只返回告警，不抛异常。 */
export function readBackendStates(root: string, extensionId: string): BackendStateRead {
  const file = backendStateFile(root, extensionId);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { states: {} };
    return { states: {}, warning: `无法读取 ${file}：${messageOf(error)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { states: {}, warning: `后端状态文件不是合法 JSON：${file}：${messageOf(error)}` };
  }
  if (!isRecord(raw)) {
    return { states: {}, warning: `后端状态文件必须是 JSON 对象：${file}` };
  }
  return { states: raw };
}

export interface PluginBackendState {
  installed: boolean;
  enabled: boolean;
  version?: string;
  path?: string;
}

/** 把状态文件里任意形状的单条记录归一化；缺失/非法值按未安装处理。 */
export function normalizeBackendState(raw: unknown): PluginBackendState {
  if (raw === undefined || raw === null) return { installed: false, enabled: false };
  if (!isRecord(raw)) return { installed: true, enabled: false };

  const installed = typeof raw.installed === "boolean" ? raw.installed : true;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : installed;
  const state: PluginBackendState = { installed, enabled };
  if (typeof raw.version === "string" && raw.version.length > 0) state.version = raw.version;
  if (typeof raw.path === "string" && raw.path.length > 0) state.path = raw.path;
  return state;
}

/** 运行时插件可见的后端集合：manifest 声明的 id、安装目录与状态。 */
export interface PluginBackends {
  /** manifest 声明的后端 id；不是目录扫描结果。 */
  readonly ids: readonly string[];

  /** `data/extension-data/<id>/backends/<backend-id>`；未安装时也返回路径。 */
  dir(id: string): string;

  /** `backends.json` 的记录；缺失且目录不存在时返回 undefined。 */
  state(id: string): PluginBackendState | undefined;
}

export function createPluginBackends(
  root: string,
  extensionId: string,
  backendIds: readonly string[],
): PluginBackends {
  const { states } = readBackendStates(root, extensionId);
  const cache = new Map<string, PluginBackendState | undefined>();
  const ids = [...backendIds];

  return {
    ids,
    dir(id) {
      return backendInstallDir(root, extensionId, id);
    },
    state(id) {
      if (cache.has(id)) return cache.get(id);

      const raw = states[id];
      const info = normalizeBackendState(raw);
      const dir = backendInstallDir(root, extensionId, id);
      const dirInstalled = fs.existsSync(dir);
      if (raw === undefined && !dirInstalled) {
        cache.set(id, undefined);
        return undefined;
      }

      const installed = info.installed || dirInstalled;
      const installedPath = info.path ?? (dirInstalled ? dir : undefined);
      const value: PluginBackendState = {
        installed,
        enabled: info.enabled,
        ...(info.version ? { version: info.version } : {}),
        ...(installedPath ? { path: installedPath } : {}),
      };
      cache.set(id, value);
      return value;
    },
  };
}
