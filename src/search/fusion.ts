/**
 * 多源融合：名次归一化 → URL 去重合并 → 按 score × engine_boost 加权排序。
 *
 * 多上游（searxng + 通用上游）场景下，各源的原始分不可直接比较，
 * 因此每个源先按「第 1 名 1.0、最后一名 1/n」归一化，再合并排序。
 * 这些函数不读 `rerank.enabled`，由调用方决定是否走加权排序。
 */

import type { CleanedResult } from "./clean.js";
import { normalizeUrlKey } from "./clean.js";
import type { SearxngResult } from "./searxng.js";

/** 源内名次归一化：第 1 名 1.0，最后一名 1/n。 */
export function rankNormalize<T extends { score?: number }>(results: readonly T[]): T[] {
  const n = results.length;
  if (n === 0) return [];
  return results.map((result, index) => ({ ...result, score: (n - index) / n }));
}

/** 合并已清洗的多个源：URL 去重、engines 并集、空字段补齐、score 取较大值。 */
export function mergeCleanedResults(lists: readonly CleanedResult[][]): CleanedResult[] {
  const byKey = new Map<string, CleanedResult>();
  const out: CleanedResult[] = [];

  for (const list of lists) {
    for (const result of list) {
      const key = normalizeUrlKey(result.url);
      const existing = byKey.get(key);
      if (!existing) {
        // 复制一份，避免后续并集/补齐修改调用方传入的对象。
        const copy: CleanedResult = { ...result, engines: [...result.engines] };
        byKey.set(key, copy);
        out.push(copy);
        continue;
      }

      for (const engine of result.engines) {
        if (!existing.engines.includes(engine)) existing.engines.push(engine);
      }
      if (!existing.content && result.content) existing.content = result.content;
      if (!existing.title && result.title) existing.title = result.title;
      if (!existing.publishedDate && result.publishedDate) {
        existing.publishedDate = result.publishedDate;
      }
      existing.score = Math.max(existing.score ?? 0, result.score ?? 0);
      if (existing.origin !== "upstream" && result.origin === "upstream") {
        existing.origin = "upstream";
      }
    }
  }

  return out;
}

/** 加权排序只需要这三个字段；CleanedResult 也满足。 */
interface WeightedResult {
  score?: number;
  engine?: string;
  engines?: string[];
}

/** 与 rerankResults 一致：`engines` 优先，否则 `engine`；多个 boost 相乘。 */
function boostFor(result: WeightedResult, engineBoost: Record<string, number>): number {
  const engines =
    result.engines && result.engines.length > 0
      ? result.engines
      : result.engine
        ? [result.engine]
        : [];
  let boost = 1.0;
  for (const engine of engines) {
    boost *= engineBoost[engine] ?? 1.0;
  }
  return boost;
}

/** 按 score × engine_boost 稳定降序排序；不修改入参。 */
export function sortByWeightedScore<T extends SearxngResult>(
  results: readonly T[],
  engineBoost: Record<string, number>,
): T[];
/** 多上游融合后的结果是 CleanedResult（无 index signature），单独给一个重载。 */
export function sortByWeightedScore(
  results: readonly CleanedResult[],
  engineBoost: Record<string, number>,
): CleanedResult[];
export function sortByWeightedScore<T extends WeightedResult>(
  results: readonly T[],
  engineBoost: Record<string, number>,
): T[] {
  return [...results].sort((a, b) => {
    const sa = (a.score ?? 0) * boostFor(a, engineBoost);
    const sb = (b.score ?? 0) * boostFor(b, engineBoost);
    return sb - sa;
  });
}
