/**
 * data: URI 图片解析。
 *
 * 页面里内嵌的 base64/百分号编码图片不能直接塞进 markdown（会把上下文撑满），
 * 但也不该静默丢掉：解析出字节后交给 FetchStore 落盘，换成 `/files/<id>` 链接。
 */

export interface ParsedDataImage {
  contentType: string;
  bytes: Buffer;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 解析 `data:image/png;base64,...` / `data:image/svg+xml,%3Csvg...`。
 * 非图片、空数据、非法 base64 一律返回 undefined。
 */
export function parseDataImage(src: string): ParsedDataImage | undefined {
  if (!/^data:/i.test(src)) return undefined;

  const comma = src.indexOf(",");
  if (comma === -1) return undefined;

  const meta = src.slice("data:".length, comma);
  const payload = src.slice(comma + 1);
  const parts = meta.split(";");
  const contentType = (parts[0] ?? "").trim().toLowerCase();
  if (!contentType.startsWith("image/")) return undefined;

  const isBase64 = parts.slice(1).some((part) => part.trim().toLowerCase() === "base64");
  let bytes: Buffer;
  if (isBase64) {
    const compact = payload.replace(/\s+/g, "");
    if (compact.length === 0 || !BASE64_RE.test(compact)) return undefined;
    bytes = Buffer.from(compact, "base64");
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(payload), "utf8");
    } catch {
      return undefined;
    }
  }

  if (bytes.length === 0) return undefined;
  return { contentType, bytes };
}
