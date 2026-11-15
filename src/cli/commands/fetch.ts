/**
 * `asg fetch <url> [选项]`：对运行中的网关做一次抓取冒烟测试。
 *
 * 只调用 MCP 的 fetch 工具，不写配置、不重启服务。人类模式直接输出
 * 网关返回的 markdown/正文；`--json` 额外给出 endpoint、耗时和错误码。
 */

import type { CommandFn } from "../context.js";
import { callGatewayTool, looksLikeToolFailure } from "../dataplane.js";
import {
  optionInteger,
  optionString,
  optionTimeoutSeconds,
  parseOptions,
  toolFailure,
  toolSuccess,
  usage,
} from "./dataplane-common.js";

const USAGE =
  "用法: asg fetch <url> [--max-chars <n>] [--render auto|always|never] [--timeout <秒>]";

const VALUE_FLAGS = ["--max-chars", "--render", "--timeout"] as const;

const RENDER_MODES = ["auto", "always", "never"] as const;
type RenderMode = (typeof RENDER_MODES)[number];

function parseRender(value: string | undefined): RenderMode | undefined {
  if (value === undefined) return undefined;
  if (!(RENDER_MODES as readonly string[]).includes(value)) {
    usage(`--render 只支持 auto | always | never（当前：${value}）`);
  }
  return value as RenderMode;
}

export const run: CommandFn = async ({ root, rest }) => {
  const { values, positionals } = parseOptions(rest, VALUE_FLAGS);
  if (positionals.length !== 1) usage(`fetch 需要一个 URL\n${USAGE}`);

  const url = positionals[0]!;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    usage(`不是合法 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    usage(`fetch 只支持 http/https URL（当前：${parsed.protocol}）`);
  }

  const maxChars = optionInteger(values, "--max-chars", 1, 200000);
  const render = parseRender(optionString(values, "--render"));
  const timeoutSeconds = optionTimeoutSeconds(values);

  const args: Record<string, unknown> = { url };
  if (maxChars !== undefined) args.max_chars = maxChars;
  if (render !== undefined) args.render = render;

  const result = await callGatewayTool(root, "fetch", args, timeoutSeconds * 1000);
  const outcome = result.isError || looksLikeToolFailure(result.text)
    ? toolFailure(result, "FETCH_FAILED")
    : toolSuccess(result);
  if (outcome.data && typeof outcome.data === "object" && !Array.isArray(outcome.data)) {
    (outcome.data as Record<string, unknown>).render = render ?? "auto";
  }
  return outcome;
};
