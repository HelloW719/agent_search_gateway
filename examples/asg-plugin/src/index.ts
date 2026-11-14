/**
 * 示例抓取插件。
 *
 * 约定：不 import 网关内部模块，只导出运行期约定的命名导出 `fetch`。
 * 未来网关会读取 asg-plugin.json 的 provides，再从这个单文件里取 `fetch` / `engine`。
 */

export interface ExampleFetchContext {
  getSecret?(key: string): string | undefined;
}

export interface ExampleFetchResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export const fetch = {
  id: "example-fetch",
  platform: "example",
  name: "example-fetch",
  displayName: "Example Fetch Plugin",
  capabilities: ["html"],

  /** 只做纯 URL 判断，不读配置、不抛错。 */
  match(url: URL): boolean {
    return url.hostname === "example.com" || url.hostname.endsWith(".example.com");
  },

  enabled(): boolean {
    return true;
  },

  available(): boolean {
    return true;
  },

  async fetch(url: URL, _ctx?: ExampleFetchContext): Promise<ExampleFetchResult> {
    return {
      ok: true,
      html: `<html><body><h1>example</h1><p>${url.href}</p></body></html>`,
      finalUrl: url.href,
    };
  },
};
