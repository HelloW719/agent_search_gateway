import { describe, expect, it } from "vitest";
import { analyzeJsShell, countVisibleChars } from "../src/fetch/content.js";

describe("countVisibleChars", () => {
  it("忽略图片、链接 URL、标点与空白", () => {
    const md = `# 标题

![cover](https://example.com/a.png)

[正文链接](https://example.com/page) 后面 123 个字符。
`;
    expect(countVisibleChars(md)).toBe(countVisibleChars("标题正文链接后面123个字符"));
  });

  it("data: 图片不算正文", () => {
    const md = `![](data:image/png;base64,${"A".repeat(5000)})`;
    expect(countVisibleChars(md)).toBe(0);
  });

  it("代码块内容算正文", () => {
    expect(countVisibleChars("```ts\nconst x = 1\n```")).toBeGreaterThan(0);
  });

  it("空文本为 0", () => {
    expect(countVisibleChars("")).toBe(0);
    expect(countVisibleChars("  \n\t ")).toBe(0);
  });
});

describe("analyzeJsShell", () => {
  it("大体积 SPA 空壳（正文 0）仍能命中", () => {
    const html = `<html><head><title>App</title></head><body><div id="app"></div><script src="/bundle.js"></script>${"<script>void 0;</script>".repeat(500)}</body></html>`;
    expect(html.length).toBeGreaterThan(2000);
    const r = analyzeJsShell(html, 0);
    expect(r.likely).toBe(true);
    expect(r.reason).toBe("empty");
  });

  it("正常长文不命中", () => {
    const html = `<html><body><article><h1>标题</h1><p>${"正文".repeat(300)}</p></article><script src="/a.js"></script></body></html>`;
    const r = analyzeJsShell(html, 600);
    expect(r.likely).toBe(false);
  });

  it("短静态页（有正文节点、密度正常）不命中", () => {
    const html = `<html><head><title>短页</title></head><body><p>一句正文</p><script src="/a.js"></script></body></html>`;
    const r = analyzeJsShell(html, 4);
    expect(r.likely).toBe(false);
  });

  it("大 HTML + 极少正文 + 无正文节点 → sparse", () => {
    const html = `<html><body><div id="app">加载中</div><script src="/bundle.js"></script>${"<div></div>".repeat(4000)}</body></html>`;
    const r = analyzeJsShell(html, 3);
    expect(r.likely).toBe(true);
    expect(r.reason).toBe("sparse");
  });

  it("Cloudflare 挑战页命中 cf", () => {
    const html = `<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>`;
    const r = analyzeJsShell(html, 0);
    expect(r.likely).toBe(true);
    expect(r.reason).toBe("cf");
  });

  it("普通页面里的 challenge-platform 脚本不误判", () => {
    const html = `<html><body><article><p>${"正文".repeat(400)}</p></article><script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>`;
    const r = analyzeJsShell(html, 800);
    expect(r.likely).toBe(false);
  });

  it("仅 noscript 提示、无 script 也命中", () => {
    const html = `<html><body><noscript>Please enable JavaScript to continue.</noscript></body></html>`;
    const r = analyzeJsShell(html, 0);
    expect(r.likely).toBe(true);
    expect(r.reason).toBe("empty");
  });
});
