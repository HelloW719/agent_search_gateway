import { describe, expect, it } from "vitest";
import { parseDataImage } from "../src/fetch/data-uri.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("parseDataImage", () => {
  it("解析 base64 图片", () => {
    const r = parseDataImage(`data:image/png;base64,${PNG_1PX}`);
    expect(r?.contentType).toBe("image/png");
    expect(r?.bytes.length).toBeGreaterThan(0);
  });

  it("解析百分号编码的 SVG", () => {
    const r = parseDataImage("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E");
    expect(r?.contentType).toBe("image/svg+xml");
    expect(r?.bytes.toString("utf8")).toContain("<svg");
  });

  it("忽略非图片", () => {
    expect(parseDataImage("data:text/plain;base64,aGVsbG8=")).toBeUndefined();
  });

  it("忽略空数据与非法 base64", () => {
    expect(parseDataImage("data:image/png;base64,")).toBeUndefined();
    expect(parseDataImage("data:image/png;base64,@@@")).toBeUndefined();
    expect(parseDataImage("data:image/png")).toBeUndefined();
  });

  it("接受带空白的 base64", () => {
    const wrapped = `${PNG_1PX.slice(0, 20)}\n${PNG_1PX.slice(20)}`;
    expect(parseDataImage(`data:image/png;base64,${wrapped}`)?.bytes.length).toBeGreaterThan(0);
  });
});
