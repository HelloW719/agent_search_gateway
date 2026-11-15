/** `asg extensions search|install|list|remove|config|secret`。
 *
 * 安装/卸载只负责插件目录，**不自动重启网关**；网关下次启动（或运行
 * `asg engines`）时由 `src/extensions/loader.ts` 加载。
 *
 * `config` / `secret` 写的是网关配置文件（`gateway.yaml` 的 `extensions.<id>.config`
 * 与 `secrets.yaml` 的 `extensions.<id>.<name>`），因此和其他配置命令一样：
 * 先整体校验一次，再写一次文件，最后整栈重启一次。校验失败不落盘。
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { takeFlag, takeNumber, takeValue } from "../args.js";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import { restartForConfig } from "../runtime/stack.js";
import {
  configPaths,
  deleteYamlPath,
  documentToPlain,
  documentToText,
  getYamlPath,
  parseConfigValue,
  readYamlDocument,
  setYamlPath,
  writeConfigFile,
  type ConfigPaths,
  type LoadedDocument,
} from "../config/gateway.js";
import { validateConfigTexts } from "../config/validate.js";
import {
  describePluginConfig,
  resolvePluginConfig,
  type ConfigFieldInfo,
  type PluginConfig,
} from "../../extensions/config.js";
import {
  installExtension,
  isValidExtensionVersion,
  isValidRepo,
  listExtensions,
  loadInstalledManifest,
  removeExtension,
  searchExtensions,
  type ExtensionManifest,
  type ExtensionSearchItem,
  type InstalledExtension,
} from "../../extensions/index.js";

const RESTART_NOTICE = "整栈重启会断开所有 MCP 连接。";

/** 插件密钥名：与 `asg engines secret` 的扩展密钥规则一致。 */
const EXTENSION_SECRET_NAME = /^[a-z][a-z0-9_-]*$/;

const CONFIG_USAGE =
  "用法: asg extensions config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]";

const SECRET_USAGE =
  "用法: asg extensions secret <id> --name <name> --stdin | --clear";

const USAGE = `用法: asg extensions <search|install|list|remove|config|secret> ...

  search [query] [--limit N]       搜索 topic:asg-plugin 的 GitHub 仓库
  install <owner/repo>[@version]   下载、校验并安装第三方插件
  list                             列出已安装的第三方插件
  remove <id>                      删除 data/extensions/<id>
  config <id> [--get [key]] [--set key=value]... [--unset key]... [--file <path>] [--describe]
                                   读写 gateway.yaml → extensions.<id>.config
  secret <id> --name <name> --stdin | --clear
                                   写/删 secrets.yaml → extensions.<id>.<name>

说明：安装后不会自动重启网关，重启服务（或下次运行 asg engines）后生效；
config / secret 写入后会整栈重启一次。`;

export interface ExtensionsApi {
  install: typeof installExtension;
  list: typeof listExtensions;
  remove: typeof removeExtension;
  search: typeof searchExtensions;
}

const DEFAULT_API: ExtensionsApi = {
  install: installExtension,
  list: listExtensions,
  remove: removeExtension,
  search: searchExtensions,
};

let api: ExtensionsApi = DEFAULT_API;

/** 测试钩子：替换扩展后端，传 null 恢复默认。 */
export function setExtensionsApiForTests(overrides: Partial<ExtensionsApi> | null): void {
  api = { ...DEFAULT_API, ...(overrides ?? {}) };
}

type RestartFn = (root: string, reporter: Reporter) => Promise<void>;
type StdinReader = () => Promise<string>;

const defaultRestart: RestartFn = (root, reporter) => restartForConfig(root, reporter);

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let restart: RestartFn = defaultRestart;
let stdinReader: StdinReader = readStdinDefault;

/** 测试钩子：替换整栈重启，传 null 恢复默认。 */
export function setRestartForTests(fn: RestartFn | null): void {
  restart = fn ?? defaultRestart;
}

/** 测试钩子：替换 stdin 读取，传 null 恢复默认。 */
export function setStdinReaderForTests(fn: StdinReader | null): void {
  stdinReader = fn ?? readStdinDefault;
}

function usageError(message: string = USAGE): CliError {
  return new CliError("UNEXPECTED", EXIT.USAGE, message);
}

function usage(message: string): never {
  throw usageError(message);
}

function makeLogger(reporter: Reporter): (message: string) => void {
  return (message) => reporter.event({ event: "log", service: "extensions", message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderList(extensions: InstalledExtension[]): string {
  const header = ["ID", "VERSION", "PROVIDES", "ENTRY"];
  const rows = extensions.map((extension) => [
    extension.id,
    extension.version ?? "-",
    extension.provides && extension.provides.length > 0 ? extension.provides.join(",") : "-",
    extension.entry ?? "-",
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const lines = [format(header), ...rows.map((row) => format(row))];
  if (extensions.length === 0) {
    lines.push("", "（未安装任何第三方插件）");
  }
  for (const extension of extensions) {
    if (extension.error) lines.push(`警告: ${extension.id} 无法读取：${extension.error}`);
  }
  return lines.join("\n");
}

function renderSearch(results: ExtensionSearchItem[]): string {
  if (results.length === 0) return "没有找到匹配的插件。";
  return results
    .map((item) => {
      const description = item.description || "（无描述）";
      return `${item.repo}  ★ ${item.stars}\n  ${description}\n  ${item.url}`;
    })
    .join("\n\n");
}

export function parseInstallTarget(value: string): { repo: string; version?: string } {
  const at = value.lastIndexOf("@");
  if (at === -1) return { repo: value };
  if (at === 0 || at === value.length - 1) {
    throw usageError(`安装目标格式应为 owner/repo[@version]：${value}`);
  }
  const repo = value.slice(0, at);
  const version = value.slice(at + 1).replace(/^[vV]/, "");
  if (!isValidExtensionVersion(version)) {
    throw usageError(`版本号不合法：${value.slice(at + 1)}（示例：1.2.3）`);
  }
  return { repo, version };
}

async function runSearch(args: string[]): Promise<CommandResult> {
  const limit = takeNumber(args, "--limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw usageError("--limit 必须是 1..100 的整数");
  }
  if (args.some((arg) => arg.startsWith("-"))) {
    throw usageError(`未知选项：${args.find((arg) => arg.startsWith("-"))}\n\n${USAGE}`);
  }

  const query = args.join(" ").trim();
  const results = await api.search({
    ...(query ? { query } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    data: { query: query || null, results },
    human: renderSearch(results),
  };
}

async function runInstall(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  if (args.length !== 1) {
    throw usageError(`用法: asg extensions install <owner/repo>[@version]`);
  }
  const target = args[0]!;
  const { repo, version } = parseInstallTarget(target);
  if (!isValidRepo(repo)) {
    throw usageError(`仓库格式应为 owner/name：${repo}`);
  }

  const result = await api.install({
    root,
    repo,
    ...(version === undefined ? {} : { version }),
    logger: makeLogger(reporter),
  });

  return {
    data: result,
    human: [
      `已安装 ${result.name} (${result.id}) v${result.version}`,
      `能力: ${result.provides.join(", ")}`,
      `路径: ${result.path}`,
      "重启网关后生效。",
    ].join("\n"),
  };
}

function runList(root: string, args: string[]): CommandResult {
  if (args.length > 0) {
    throw usageError(`list 不接受额外参数：${args.join(" ")}`);
  }
  const extensions = api.list(root);
  return {
    data: { extensions },
    human: renderList(extensions),
  };
}

async function runRemove(root: string, args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    throw usageError("用法: asg extensions remove <id>");
  }
  const result = await api.remove(root, args[0]!);
  return {
    data: result,
    human: `${result.id} 已卸载。`,
  };
}

interface SetOp {
  kind: "set";
  key: string;
  value: unknown;
}

interface UnsetOp {
  kind: "unset";
  key: string;
}

type ConfigOp = SetOp | UnsetOp;

interface ConfigOptions {
  get: { present: boolean; key?: string };
  ops: ConfigOp[];
  file?: string;
  describe: boolean;
}

/** 校验点号键路径：不接受空键、空段（`a..b` / `.a` / `a.`）。 */
function parseKeyPath(raw: string, label: string): string[] {
  const segments = raw.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    usage(`${label} 的键不能为空，也不能包含首尾/连续的点：${raw}`);
  }
  return segments;
}

function parseSetOp(raw: string): SetOp {
  const eq = raw.indexOf("=");
  if (eq <= 0) usage(`--set 需要 key=value 形式：${raw}`);
  const key = raw.slice(0, eq);
  parseKeyPath(key, "--set");
  return { kind: "set", key, value: parseConfigValue(raw.slice(eq + 1)) };
}

/** 解析 config 子命令的选项；支持重复的 --set / --unset，并保持书写顺序。 */
function parseConfigOptions(rest: string[]): ConfigOptions {
  const get: { present: boolean; key?: string } = { present: false };
  const ops: ConfigOp[] = [];
  let file: string | undefined;
  let describe = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    // --json 是全局参数（parseInvocation 会先摘掉）；直接调用 run 时同样接受。
    if (arg === "--json") continue;

    if (arg === "--describe") {
      describe = true;
      continue;
    }

    if (arg === "--get" || arg.startsWith("--get=")) {
      if (get.present) usage("--get 只能使用一次");
      get.present = true;
      if (arg.startsWith("--get=")) {
        get.key = arg.slice("--get=".length);
        if (get.key.length === 0) usage("--get 的键不能为空");
      } else {
        const next = rest[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          get.key = next;
          index += 1;
        }
      }
      if (get.key !== undefined) parseKeyPath(get.key, "--get");
      continue;
    }

    if (arg === "--set" || arg.startsWith("--set=")) {
      const raw = arg === "--set" ? rest[index + 1] : arg.slice("--set=".length);
      if (raw === undefined) usage("--set 需要 key=value 形式");
      if (arg === "--set") index += 1;
      ops.push(parseSetOp(raw));
      continue;
    }

    if (arg === "--unset" || arg.startsWith("--unset=")) {
      const raw = arg === "--unset" ? rest[index + 1] : arg.slice("--unset=".length);
      if (raw === undefined) usage("--unset 需要一个配置键");
      if (arg === "--unset") index += 1;
      parseKeyPath(raw, "--unset");
      ops.push({ kind: "unset", key: raw });
      continue;
    }

    if (arg === "--file" || arg.startsWith("--file=")) {
      if (file !== undefined) usage("--file 只能使用一次");
      const raw = arg === "--file" ? rest[index + 1] : arg.slice("--file=".length);
      if (raw === undefined || raw.length === 0) usage("--file 需要一个文件路径");
      if (arg === "--file") index += 1;
      file = raw;
      continue;
    }

    usage(`未知选项：${arg}\n\n${CONFIG_USAGE}`);
  }

  return { get, ops, ...(file === undefined ? {} : { file }), describe };
}

function assertConfigModes(options: ConfigOptions): void {
  const writing = options.ops.length > 0 || options.file !== undefined;
  if (options.file !== undefined && options.ops.length > 0) {
    usage("--file 不能与 --set / --unset 同时使用");
  }
  if (writing && options.get.present) {
    usage("--get 不能与 --set / --unset / --file 同时使用");
  }
  if (writing && options.describe) {
    usage("--describe 不能与 --set / --unset / --file 同时使用");
  }
  if (options.get.present && options.describe) {
    usage("--describe 不能与 --get 同时使用");
  }
}

/** 读取网关配置文档；文件缺失时按 NOT_INSTALLED 处理（与其他配置命令一致）。 */
function loadGatewayDocument(root: string): {
  paths: ConfigPaths;
  config: LoadedDocument;
} {
  const paths = configPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${paths.config}`);
  }
  return { paths, config: readYamlDocument(paths.config) };
}

/** `extensions.<id>.config` 的原始值；只接受对象或缺省。 */
function readRawConfig(
  config: LoadedDocument,
  id: string,
): Record<string, unknown> | undefined {
  const raw = getYamlPath(config.doc, ["extensions", id, "config"]);
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, `extensions.${id}.config 必须是对象`);
  }
  return raw;
}

function digPlain(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setDeep(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
      continue;
    }
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    throw new CliError(
      "CONFIG_INVALID",
      EXIT.INVALID,
      `配置键 ${path.join(".")} 的父级 ${segment} 不是对象`,
    );
  }
  current[path[path.length - 1]!] = value;
}

/** 删除嵌套键，并向上清理变空的父对象（候选对象本身保留）。 */
function unsetDeep(target: Record<string, unknown>, path: readonly string[]): boolean {
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current: Record<string, unknown> = target;

  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) return false;
    parents.push({ parent: current, key: segment });
    current = next;
  }

  const leaf = path[path.length - 1]!;
  const existed = Object.hasOwn(current, leaf);
  delete current[leaf];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { parent, key } = parents[index]!;
    const child = parent[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete parent[key];
      continue;
    }
    break;
  }

  return existed;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "undefined";
}

function formatDefault(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
}

function renderConfigFields(fields: ConfigFieldInfo[]): string {
  if (fields.length === 0) return "config_schema 没有声明任何顶层字段。";

  const rows = fields.map((field) => [
    field.key,
    field.type,
    field.required
      ? "必填"
      : field.default === undefined
        ? "-"
        : `默认 ${formatDefault(field.default)}`,
    field.description ?? "",
  ]);

  const widths = [0, 1, 2].map((index) =>
    Math.max(...rows.map((row) => row[index]!.length)),
  );
  return rows
    .map((row) =>
      `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!.padEnd(widths[2]!)}  ${row[3]!}`.trimEnd(),
    )
    .join("\n");
}

function runConfigDescribe(id: string, manifest: ExtensionManifest): CommandResult {
  if (manifest.config_schema === undefined) {
    return {
      data: { id, fields: [] },
      human: "未声明 config_schema，配置会原样透传。",
    };
  }
  const fields = describePluginConfig(manifest.config_schema);
  return {
    data: { id, fields },
    human: renderConfigFields(fields),
  };
}

function runConfigRead(
  id: string,
  manifest: ExtensionManifest,
  raw: Record<string, unknown> | undefined,
  get: ConfigOptions["get"],
): CommandResult {
  const resolved = resolvePluginConfig(manifest.config_schema, raw);

  const config: PluginConfig = resolved.ok ? resolved.value : (raw ?? {});
  const data: Record<string, unknown> = resolved.ok
    ? { id, config, valid: true }
    : { id, config, valid: false, error: resolved.error };

  if (get.key !== undefined) {
    const value = digPlain(config, get.key.split("."));
    if (value === undefined) {
      throw new CliError("CONFIG_INVALID", EXIT.INVALID, `配置中没有该路径：${get.key}`);
    }
    return {
      data: { ...data, key: get.key, value },
      human: `${get.key}: ${formatValue(value)}`,
    };
  }

  const text = JSON.stringify(config, null, 2);
  return {
    data,
    human: resolved.ok ? text : `配置未通过校验：${resolved.error}\n${text}`,
  };
}

async function runConfigWrite(
  root: string,
  reporter: Reporter,
  id: string,
  manifest: ExtensionManifest,
  paths: ConfigPaths,
  config: LoadedDocument,
  raw: Record<string, unknown> | undefined,
  options: ConfigOptions,
): Promise<CommandResult> {
  let candidate: Record<string, unknown>;
  const changed = new Set<string>();

  if (options.file !== undefined) {
    if (!existsSync(options.file)) {
      throw new CliError("CONFIG_INVALID", EXIT.INVALID, `未找到配置文件：${options.file}`);
    }
    // YAML 解析器同时接受 JSON（JSON 是 YAML 的子集）；根必须是对象。
    candidate = documentToPlain(readYamlDocument(options.file).doc);
    changed.add(`extensions.${id}.config`);
  } else {
    candidate = structuredClone(raw ?? {});
    for (const op of options.ops) {
      if (op.kind === "set") {
        const keyPath = op.key.split(".");
        const before = digPlain(candidate, keyPath);
        setDeep(candidate, keyPath, op.value);
        // 只有值真正变化才算 changed，方便脚本判断是否需要后续动作。
        if (JSON.stringify(before) !== JSON.stringify(op.value)) {
          changed.add(`extensions.${id}.config.${op.key}`);
        }
      } else if (unsetDeep(candidate, op.key.split("."))) {
        changed.add(`extensions.${id}.config.${op.key}`);
      }
    }
  }

  // 校验失败 → CONFIG_INVALID，目标文件保持原样。
  const resolved = resolvePluginConfig(manifest.config_schema, candidate);
  if (!resolved.ok) {
    throw new CliError("CONFIG_INVALID", EXIT.INVALID, resolved.error);
  }

  const configPath = ["extensions", id, "config"] as const;
  if (Object.keys(candidate).length === 0) {
    // deleteYamlPath 会继续清理空的 extensions.<id>，但保留顶层 extensions。
    deleteYamlPath(config.doc, configPath);
  } else {
    setYamlPath(config.doc, configPath, candidate);
  }

  const configText = documentToText(config.doc);
  const secrets = readYamlDocument(paths.secrets);
  const { warnings } = validateConfigTexts({
    configText,
    secretsText: secrets.exists ? secrets.text : undefined,
  });
  for (const warning of warnings) reporter.info(`警告: ${warning}`);

  writeConfigFile(paths.config, configText);
  await restart(root, reporter);

  return {
    data: {
      id,
      config: resolved.value,
      changed: [...changed],
      restart: "all",
      restarted: true,
    },
    human: [
      `已更新扩展 ${id} 的配置。`,
      "服务已整栈重启并通过健康检查。",
      RESTART_NOTICE,
    ].join("\n"),
  };
}

async function runConfig(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const [idRaw, ...rest] = args;
  if (idRaw === undefined || idRaw.startsWith("-")) usage(CONFIG_USAGE);

  const id = idRaw;
  const options = parseConfigOptions(rest);
  assertConfigModes(options);

  const manifest = loadInstalledManifest(root, id);
  const { paths, config } = loadGatewayDocument(root);
  const raw = readRawConfig(config, id);

  if (options.describe) return runConfigDescribe(id, manifest);
  if (options.ops.length > 0 || options.file !== undefined) {
    return runConfigWrite(root, reporter, id, manifest, paths, config, raw, options);
  }
  return runConfigRead(id, manifest, raw, options.get);
}

async function runSecret(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  const [idRaw, ...rest] = args;
  if (idRaw === undefined || idRaw.startsWith("-")) usage(SECRET_USAGE);

  const id = idRaw;
  const stdin = takeFlag(rest, "--stdin");
  const clear = takeFlag(rest, "--clear");
  const name = takeValue(rest, "--name");

  if (stdin && clear) usage("--stdin 与 --clear 只能二选一");
  if (!stdin && !clear) usage("需要 --stdin（从标准输入读取密钥）或 --clear");
  if (name === undefined) usage("必须用 --name 指定密钥名");
  if (!EXTENSION_SECRET_NAME.test(name)) {
    usage(`密钥名不合法：${name}（要求 [a-z][a-z0-9_-]*）`);
  }
  if (rest.length > 0) usage(SECRET_USAGE);

  // 与 config 一致：id 必须指向已安装插件（manifest 损坏也算插件错误）。
  loadInstalledManifest(root, id);

  const paths = configPaths(root);
  if (!existsSync(paths.config)) {
    throw new CliError("NOT_INSTALLED", EXIT.MISSING, `未找到配置文件：${paths.config}`);
  }
  const config = readYamlDocument(paths.config);
  const secrets = readYamlDocument(paths.secrets);

  const display = `secrets.extensions.${id}.${name}`;
  const secretPath = ["extensions", id, name] as const;

  let text: string | undefined;
  if (clear) {
    if (deleteYamlPath(secrets.doc, secretPath)) {
      text = documentToText(secrets.doc);
    }
  } else {
    const value = (await stdinReader()).replace(/\r?\n$/, "");
    if (value.trim().length === 0) {
      usage("密钥不能为空；如需删除请使用 --clear");
    }
    setYamlPath(secrets.doc, secretPath, value);
    text = documentToText(secrets.doc);
  }

  if (text !== undefined) {
    // secrets.yaml 一律 0600，避免密钥对 group/other 可读。
    const { warnings } = validateConfigTexts({
      configText: documentToText(config.doc),
      secretsText: text,
    });
    for (const warning of warnings) reporter.info(`警告: ${warning}`);
    writeConfigFile(paths.secrets, text, 0o600);
  }

  await restart(root, reporter);

  return {
    data: {
      id,
      name,
      changed: text === undefined ? [] : [display],
      restart: "all",
      restarted: true,
    },
    human: clear ? `已删除密钥: ${display}` : `已更新密钥: ${display}`,
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand, ...args] = rest;

  switch (subcommand) {
    case "search":
      return runSearch(args);
    case "install":
      return runInstall(root, reporter, args);
    case "list":
      return runList(root, args);
    case "remove":
      return runRemove(root, args);
    case "config":
      return runConfig(root, reporter, args);
    case "secret":
      return runSecret(root, reporter, args);
    case "-h":
    case "--help":
      return { data: { usage: USAGE }, human: USAGE };
    case undefined:
      throw usageError(USAGE);
    default:
      throw usageError(
        `未知 extensions 子命令：${subcommand}（可用: search | install | list | remove | config | secret）`,
      );
  }
};
