/**
 * `asg search [query] [选项]`：对运行中的网关做一次搜索冒烟测试。
 *
 * 只调用 MCP 的 search 工具，不写配置、不重启服务。人类模式直接输出
 * 网关返回的 markdown；`--json` 额外给出 endpoint、耗时和错误码。
 */

import { resolve } from "node:path";
import type { CommandFn } from "../context.js";
import { callGatewayTool, looksLikeToolFailure } from "../dataplane.js";
import {
  optionInteger,
  optionNumber,
  optionString,
  optionTimeoutSeconds,
  parseOptions,
  toolFailure,
  toolSuccess,
  usage,
} from "./dataplane-common.js";

const USAGE =
  "用法: asg search [query] [--categories <a,b>] [--engines <a,b>] [--language <code>] " +
  "[--safesearch 0|1|2] [--num-results <n>] [--fanout 1-4] [--min-score 0-1] " +
  "[--image-path <文件>] [--timeout <秒>]";

const VALUE_FLAGS = [
  "--categories",
  "--engines",
  "--language",
  "--safesearch",
  "--num-results",
  "--fanout",
  "--min-score",
  "--image-path",
  "--timeout",
] as const;

export const run: CommandFn = async ({ root, rest }) => {
  const { values, positionals } = parseOptions(rest, VALUE_FLAGS);
  if (positionals.length > 1) usage(`search 只接受一个 query（含空格请加引号）\n${USAGE}`);

  const query = positionals[0] ?? "";
  const categories = optionString(values, "--categories");
  const engines = optionString(values, "--engines");
  const language = optionString(values, "--language");
  const safesearch = optionString(values, "--safesearch");
  const numResults = optionInteger(values, "--num-results", 1, 1000);
  const fanout = optionInteger(values, "--fanout", 1, 4);
  const minScore = optionNumber(values, "--min-score", 0, 1);
  const timeoutSeconds = optionTimeoutSeconds(values);
  const imagePathRaw = optionString(values, "--image-path");
  const imagePath = imagePathRaw === undefined ? undefined : resolve(imagePathRaw);

  if (safesearch !== undefined && !["0", "1", "2"].includes(safesearch)) {
    usage(`--safesearch 只支持 0 / 1 / 2（当前：${safesearch}）`);
  }
  if (!query && imagePath === undefined && categories === undefined) {
    usage(`search 需要 query，或 --image-path / --categories\n${USAGE}`);
  }

  const args: Record<string, unknown> = { query };
  if (categories !== undefined) args.categories = categories;
  if (engines !== undefined) args.engines = engines;
  if (language !== undefined) args.language = language;
  if (safesearch !== undefined) args.safesearch = safesearch;
  if (numResults !== undefined) args.num_results = numResults;
  if (fanout !== undefined) args.fanout = fanout;
  if (minScore !== undefined) args.min_score = minScore;
  if (imagePath !== undefined) args.image_path = imagePath;

  const result = await callGatewayTool(root, "search", args, timeoutSeconds * 1000);
  return result.isError || looksLikeToolFailure(result.text)
    ? toolFailure(result, "SEARCH_FAILED")
    : toolSuccess(result);
};
