import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/fetch/html2md.js";

describe("htmlToMarkdown", () => {
  it("提取 title", () => {
    const r = htmlToMarkdown("<html><head><title>  Page Title </title></head><body><p>hi</p></body></html>", {
      structural: "clean",
      baseUrl: "https://example.com",
      maxOutputChars: 10000,
    });
    expect(r.title).toBe("Page Title");
  });

  it("head 里的内联脚本不进正文（clean/full 都不进）", () => {
    const html =
      '<html><head><title>T</title><script>var x = "head-script";</script></head>' +
      "<body><article><p>正文</p></article></body></html>";
    for (const structural of ["clean", "full"] as const) {
      const r = htmlToMarkdown(html, { structural, baseUrl: "https://e.com", maxOutputChars: 10000 });
      expect(r.markdown).not.toContain("head-script");
      expect(r.markdown).toContain("正文");
    }
  });

  it("clean 模式移除 nav/footer/script/style/广告容器", () => {
    const html = `
      <html><body>
        <nav>navigation</nav>
        <footer>footer</footer>
        <div class="ad-banner">ad</div>
        <script>evil()</script>
        <style>.x{}</style>
        <article><h1>Content</h1><p>real text</p></article>
      </body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).not.toContain("navigation");
    expect(r.markdown).not.toContain("footer");
    expect(r.markdown).not.toContain("ad");
    expect(r.markdown).not.toContain("evil");
    expect(r.markdown).toContain("Content");
    expect(r.markdown).toContain("real text");
  });

  it("full 模式保留 nav/footer", () => {
    const html = `<html><body><nav>nav text</nav><p>body</p><footer>foot</footer></body></html>`;
    const r = htmlToMarkdown(html, { structural: "full", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).toContain("nav text");
    expect(r.markdown).toContain("foot");
  });

  it("相对 URL 转绝对", () => {
    const html = `<html><body><a href="/about">about</a><img src="img.png"></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://example.com/docs/", maxOutputChars: 10000 });
    expect(r.markdown).toContain("https://example.com/about"); // 根相对 → 域根
    expect(r.markdown).toContain("https://example.com/docs/img.png"); // 相对 → 相对 base 目录
  });

  it("保留链接/代码块/标题层级", () => {
    const html = `<html><body><h1>H1</h1><pre><code>const x = 1</code></pre><a href="https://x.com">link</a></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).toContain("# H1");
    expect(r.markdown).toContain("```");
    expect(r.markdown).toContain("[link](https://x.com/)");
  });

  it("超长内容截断", () => {
    const long = "<html><body>" + "<p>word</p>".repeat(5000) + "</body></html>";
    const r = htmlToMarkdown(long, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 200 });
    expect(r.markdown.length).toBeLessThanOrEqual(220);
    expect(r.markdown).toContain("内容已截断");
  });

  it("丢弃 data: URI 图片", () => {
    const html = `<html><body><p>正文</p><img src="data:image/png;base64,${"A".repeat(1000)}"><img src="https://e.com/a.png"></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).not.toContain("data:image");
    expect(r.markdown).toContain("https://e.com/a.png");
  });

  it("data: URI 图片可由 resolveImage 换成落盘链接", () => {
    const html = `<html><body><img alt="chart" src="data:image/png;base64,AAAA"></body></html>`;
    const r = htmlToMarkdown(html, {
      structural: "clean",
      baseUrl: "https://e.com",
      maxOutputChars: 10000,
      resolveImage: (src) => (src.startsWith("data:image/png") ? "http://127.0.0.1:3000/files/abc" : undefined),
    });
    expect(r.markdown).toContain("![chart](http://127.0.0.1:3000/files/abc)");
    expect(r.markdown).not.toContain("data:image");
  });

  it("clean 不删除 html 根节点（Wikipedia 的 class 命中 [class*='menu']）", () => {
    // 复刻 https://en.wikipedia.org/wiki/HTTP：根节点 class 含 "main-menu"，正文在 article 里
    const html = `<html class="vector-feature-main-menu-pinned-disabled"><head><title>HTTP</title></head><body><article><p>超文本传输协议是一种应用层协议。</p></article></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://en.wikipedia.org/wiki/HTTP", maxOutputChars: 10000 });
    expect(r.markdown).toContain("超文本传输协议");
    expect(r.contentChars).toBeGreaterThan(0);
  });

  it("clean 仍删除 body 内的 nav", () => {
    const html = `<html><body><nav>menu</nav><article><p>正文</p></article></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).not.toContain("menu");
    expect(r.markdown).toContain("正文");
    expect(r.contentChars).toBe(2);
  });

  it("clean 误清空时回退到 full（正文容器 class 命中噪音选择器）", () => {
    const html = `<html><body><div class="menu-wrapper"><article><p>正文</p></article></div></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 10000 });
    expect(r.markdown).toContain("正文");
    expect(r.contentChars).toBe(2);
  });

  it("真正空页仍返回空正文（不靠 full 兜底误报）", () => {
    const emptyBody = htmlToMarkdown(`<html><body><div id="app"></div></body></html>`, {
      structural: "clean",
      baseUrl: "https://e.com",
      maxOutputChars: 10000,
    });
    expect(emptyBody.markdown).toBe("");
    expect(emptyBody.contentChars).toBe(0);

    // 纯 JS 空壳：body 里只有 script，full 兜底不应把脚本源码当正文
    const jsShell = htmlToMarkdown(`<html><body><script>var app = {}</script></body></html>`, {
      structural: "clean",
      baseUrl: "https://e.com",
      maxOutputChars: 10000,
    });
    expect(jsShell.contentChars).toBe(0);
  });

  it("contentChars 统计截断前的正文（不含图片/标题）", () => {
    const html = `<html><head><title>标题</title></head><body><p>正文内容</p><img src="data:image/png;base64,${"A".repeat(5000)}"></body></html>`;
    const r = htmlToMarkdown(html, { structural: "clean", baseUrl: "https://e.com", maxOutputChars: 2 });
    expect(r.contentChars).toBe(4);
    expect(r.markdown.length).toBeLessThan(20);
  });
});
