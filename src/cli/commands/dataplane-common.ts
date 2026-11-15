/** `asg search` / `asg fetch` 共用的参数解析与结果构造。 */

import type { CommandResult } from "../context.js";
import type { GatewayToolName, GatewayToolResult } from "../dataplane.js";
import { parseToolFailure } from "../dataplane.js";
import { CliError, EXIT } from "../errors.js";

export interface ParsedOptions {
  values: Record<string, string>;
  positionals: string[];
}

export function usage(message: string): never {
  throw new CliError("UNEXPECTED", EXIT.USAGE, message);
}

/**
 * 顺序解析 `--name value` / `--name=value`，支持 `--` 结束选项。
 *
 * search/fetch 是面向人的命令，未知选项直接报错，避免把拼错的 flag 当成查询。
 */
export function parseOptions(rest: string[], valueFlags: readonly string[]): ParsedOptions {
  const allowed = new Set(valueFlags);
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!allowed.has(name)) usage(`未知选项：${name}`);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      if (inline !== undefined) {
        values[name] = inline;
        continue;
      }
      const value = rest[i + 1];
      if (value === undefined) usage(`${name} 需要一个值`);
      values[name] = value;
      i += 1;
      continue;
    }

    positionals.push(arg);
  }

  return { values, positionals };
}

export function optionString(values: Record<string, string>, name: string): string | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) usage(`${name} 需要一个非空值`);
  return value;
}

export function optionInteger(
  values: Record<string, string>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    usage(`${name} 需要 ${min}-${max} 之间的整数（当前：${raw}）`);
  }
  return value;
}

export function optionNumber(
  values: Record<string, string>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    usage(`${name} 需要 ${min}-${max} 之间的数字（当前：${raw}）`);
  }
  return value;
}

export const DEFAULT_TIMEOUT_SECONDS = 120;

export function optionTimeoutSeconds(values: Record<string, string>): number {
  return optionNumber(values, "--timeout", 1, 3600) ?? DEFAULT_TIMEOUT_SECONDS;
}

/** MCP 工具成功结果：人类模式打印 markdown，JSON 带文本与耗时。 */
export function toolSuccess(result: GatewayToolResult): CommandResult {
  return {
    data: {
      tool: result.tool,
      endpoint: result.endpoint,
      elapsed_ms: result.elapsedMs,
      ok: true,
      code: null,
      text: result.text,
    },
    human: result.text,
  };
}

/** MCP 工具失败：保留完整错误文本，把 `[CODE]` 拆成 error.code。 */
export function toolFailure(result: GatewayToolResult, fallbackCode: string): CommandResult {
  const failure = parseToolFailure(result.text, fallbackCode);
  return {
    data: {
      tool: result.tool,
      endpoint: result.endpoint,
      elapsed_ms: result.elapsedMs,
      ok: false,
      code: failure.code,
      text: result.text,
    },
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      details: { endpoint: result.endpoint, tool: result.tool as GatewayToolName },
    },
    exitCode: EXIT.FAIL,
  };
}
