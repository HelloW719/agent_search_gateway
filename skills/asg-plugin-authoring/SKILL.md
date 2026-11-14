---
name: asg-plugin-authoring
description: 为 agent-search-gateway（asg）编写、迁移或发布第三方插件时使用。适用于：从零生成一个 asg 插件仓库、把网关内置的 fetch/search 能力抽成独立插件、编写 asg-plugin.json、打包单文件 ESM（index.mjs）、补测试，以及配置 GitHub Actions 的 v* Release 与 asg-plugin topic。
---

# 编写 asg 第三方插件

本 skill 指导你从零产出一个可安装、可发布的 asg 插件仓库。所有结论以
`agent-search-gateway`（下称“网关”）当前的运行期约定为准。

## 何时使用

- 用户要为某个站点写 **取件插件**（`fetch`），例如接管 `example.com/article/...`。
- 用户要为某个来源写 **搜索源 / 图搜源**（`engine`），例如新增 `gateway.search` 文本源。
- 用户要把网关里的内置实现迁出成独立插件仓库。
- 用户要发布插件（`asg-plugin.json` + `index.mjs` + `SHA256SUMS`）。

## 0. 运行期契约（先记住这几条）

1. 插件入口是**单文件 ESM**（默认 `index.mjs`），只认两个命名导出：
   - `export const fetch`：取件插件（`FetchPlugin` 形状）；
   - `export const engine`：引擎 provider（`EngineProvider` 形状）；
   - 两者可在同一文件同时导出（`provides: ["search", "fetch"]`）。
2. **禁止** `import "agent-search-gateway"` 或其内部模块（`src/...`）。运行期不保证宿主
   `node_modules` 存在，也不保证内部路径稳定。只允许：
   - Node 内置模块（`node:*`，esbuild 里保持 external）；
   - 自己的源码；
   - 需要第三方库时，把它 bundle 进 `index.mjs`。
3. `src/index.ts` 里如果写 `export const fetch = ...`，该模块内**不要再用全局 `fetch`**
   （会被同名绑定遮蔽）。把实现放到 `src/plugin.ts`，入口只做再导出。
4. 类型可以自由复制：建 `src/sdk/`，把需要的契约类型与运行期工具（`runCliProcess`、
   `Semaphore`、通道常量等）复制进去，不要从宿主 import。
5. `asg-plugin.json` 是**严格校验**的：只允许 `id/name/version/api_version/provides/entry/platform/description`，
   多一个字段都会安装失败。
6. 从 **0.3.4** 起，网关内置的 `bilibili` / `weibo` / `cnki` 已迁出为官方插件仓库，
   用户需要安装官方插件（见文末）而不是依赖内置实现。旧版本（≤0.3.3）会把这些 id
   当作内置能力拒绝安装，先升级网关。

## 1. 生成仓库骨架

```text
<repo>/
├── asg-plugin.json           # manifest（严格字段）
├── package.json              # type: module；build / test / typecheck
├── package-lock.json         # npm install 生成，随提交
├── tsconfig.json
├── esbuild.config.mjs        # bundle → index.mjs
├── vitest.config.ts          # 只跑 TS 单测
├── .gitignore                # node_modules/ index.mjs SHA256SUMS
├── LICENSE                   # MIT
├── README.md                 # 能力、配置、安装、发版
├── src/
│   ├── index.ts              # 只导出 fetch / engine
│   ├── plugin.ts             # fetch 实现（可拆成多文件）
│   ├── engine.ts             # engine 实现（可选）
│   └── sdk/                  # 复制的契约类型与工具
├── test/
│   ├── exports.test.ts
│   ├── ...                   # 行为单测
│   └── build.test.mjs        # 构建产物冒烟（node --test）
└── .github/workflows/release.yml
```

### package.json

```json
{
  "name": "agent-search-gateway-plugin-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "asg 插件：example.com 取件",
  "license": "MIT",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "npm run build && vitest run && node --test test/build.test.mjs",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

**不要添加运行期 dependencies**。所有运行期代码必须被 bundle 进 `index.mjs`。

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "index.mjs"]
}
```

### esbuild.config.mjs（单文件 ESM）

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["node:*"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
```

### vitest.config.ts

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 只跑 TS 单测；构建产物冒烟由 `node --test test/build.test.mjs` 负责。
  test: { include: ["test/**/*.test.ts"] },
});
```

### .gitignore

```gitignore
node_modules/
index.mjs
SHA256SUMS
```

### asg-plugin.json

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "一句话说明插件能力"
}
```

字段细节见 `references/manifest.md`。

## 2. 实现 fetch（取件插件）

`src/index.ts`：

```ts
import { examplePlugin } from "./plugin.js";

export const fetch = examplePlugin;        // 运行期约定：命名导出 fetch
```

`src/plugin.ts` 必须满足 `FetchPlugin`：

| 字段 | 说明 |
| --- | --- |
| `id` / `platform` | 规范平台 ID（通常相同） |
| `name` / `displayName` | 内部名 / 展示名 |
| `capabilities` | 例如 `["article"]`、`["video", "comments"]`、`["pdf"]` |
| `aliases?` / `settingsKey?` / `requires?` / `channels?` | 可选元数据 |
| `match(url)` | **纯 URL 判断**：不读配置、不抛错、不发请求 |
| `enabled?(ctx)` | 统一开关；返回 false 时宿主跳过插件并回退通用抓取 |
| `available?(ctx)` | 维护面可用性（健康检查/列表），**不参与** URL 匹配 |
| `fetch(url, ctx)` | 返回 `FetchPluginResult` |

结果形状：

```ts
{
  ok: boolean;            // 成功/失败
  status?: number;
  contentType?: string;
  finalUrl?: string;
  bytes?: Buffer;         // 二进制/文本产物
  html?: string;          // 或由宿主转 Markdown 的 HTML（二选一）
  errorCode?: string;     // 自定义错误码，例如 NOT_SUBSCRIBED
  errorMessage?: string;  // 面向 agent 的错误说明
}
```

`ctx` 提供 `settings`（与 `gateway.yaml` 同形的设置切片）、`secrets`、`getSecret(path)`、
`logger` 与可选 `pluginConfig`。不要假设宿主帮你处理 cookie/会话/重定向——插件自己管。

完整可复制示例见 `examples/fetch-plugin.ts`；契约细节见 `references/fetch-plugin.md`。

## 3. 实现 engine（搜索源 / 图搜源）

`provides` 含 `"search"` 时必须导出 `engine`：

```ts
import { weiboProvider } from "./engine.js";

export const engine = weiboProvider;
```

`EngineProvider` 的关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `${group}:${name}`，例如 `gateway.search:example` |
| `group` | `"gateway.search"`（文本源）或 `"gateway.reverse_image"`（图搜源） |
| `kind` | 固定 `"gateway"` |
| `routing(ctx)` | 返回 `category:<name>`，用于类别分发 |
| `available(ctx)` | 前置条件（密钥、上游开关） |
| `enabled?(ctx)` | 引擎自身开关；`enabledPath` 指向写入 `gateway.yaml` 的布尔路径 |
| `runtime` | `{ kind: "search", plan, search }` 或 `{ kind: "reverse_image", search }` |

文本源（`gateway.search`）：

```ts
runtime: {
  kind: "search",
  plan(categories, ctx) {
    // categories 是逗号分隔字符串；命中热搜类别时 hot = true
    return hasCategory(categories, "example_hot") ? { hot: true } : undefined;
  },
  async search(query, { hot, limit }, ctx) {
    // 返回 { ok: true, results, latencyMs } 或 { ok: false, error, latencyMs }
  },
}
```

图搜源（`gateway.reverse_image`）：

```ts
runtime: {
  kind: "reverse_image",
  async search(input, ctx) {
    // input: { kind: "url", url } | { kind: "bytes", bytes, filename, mime }
    // 返回 SourceCall：{ ok: true, results, latencyMs } | { ok: false, error }
  },
}
```

完整示例见 `examples/search-engine.ts`；细节见 `references/search-engine.md`。

## 4. 测试

最低要求：

```ts
// test/exports.test.ts
import { describe, expect, it } from "vitest";
import { fetch as plugin } from "../src/index.js";

describe("导出形状", () => {
  it("导出 fetch 插件对象", () => {
    expect(plugin).toBeTypeOf("object");
    expect(typeof plugin.match).toBe("function");
    expect(typeof plugin.fetch).toBe("function");
  });

  it("match 纯 URL 判断", () => {
    expect(plugin.match(new URL("https://example.com/article/1"))).toBe(true);
    expect(plugin.match(new URL("https://example.org/article/1"))).toBe(false);
  });
});
```

若导出 `engine`，追加：

```ts
expect(engine.group).toBe("gateway.search");
expect(engine.runtime?.kind).toBe("search");
```

构建产物冒烟（`node --test`）：

```js
// test/build.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

test("bundle 可加载并导出 fetch", async () => {
  const mod = await import("../index.mjs");
  assert.equal(typeof mod.fetch, "object");
  assert.equal(typeof mod.fetch.match, "function");
  assert.equal(typeof mod.fetch.fetch, "function");
});
```

运行：

```bash
npm install
npm run typecheck
npm test        # build + vitest + node --test
```

测试建议：

- 用本地 HTTP 桩服务器 / 假 CLI 脚本覆盖 `fetch` 的主路径与错误码，不打真实站点；
- 密钥、网络、登录态都从 `ctx` 注入，测试里直接构造设置对象，不依赖网关的 settings loader；
- 需要指向本地桩服务器时，把端点/策略导出成可变对象（如 `endpoints`、`policy`），测试里改写。

## 5. CI 发布（tag `v*`）

`.github/workflows/release.yml`：

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: sha256sum index.mjs asg-plugin.json > SHA256SUMS
      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" \
            index.mjs asg-plugin.json SHA256SUMS \
            --title "agent-search-gateway-plugin-example ${GITHUB_REF_NAME}" \
            --generate-notes
```

发布步骤：

1. 同时改 `asg-plugin.json` 与 `package.json` 的版本号；
2. `git tag v0.1.0 && git push origin v0.1.0`；
3. 等 Actions 创建 Release（资产：`index.mjs`、`asg-plugin.json`、`SHA256SUMS`）。

`version` 必须与 tag 去掉 `v` 后一致；安装器会校验 `SHA256SUMS`，不要手工替换资产。
细节见 `references/release.md`。

## 6. 发现与安装

- 给 GitHub 仓库加 topic：**`asg-plugin`**（`asg extensions search` 依赖它）；
- 用户安装：

```bash
asg extensions install <owner>/<repo>@0.1.0
asg extensions list
```

官方插件仓库：

```bash
asg extensions install djasdh/agent-search-gateway-plugin-bilibili@0.1.0
asg extensions install djasdh/agent-search-gateway-plugin-weibo@0.1.0
asg extensions install djasdh/agent-search-gateway-plugin-cnki@0.1.0
```

## 7. 交付前检查清单

- [ ] `src/index.ts` 导出 `fetch`（以及需要时的 `engine`），且没有遮蔽全局 `fetch`；
- [ ] `match` 只做 URL 判断，不读配置、不发请求、不抛错；
- [ ] 没有 import `agent-search-gateway` 或宿主 `node_modules`；
- [ ] `package.json` 无运行期依赖，`npm run build` 只产出 `index.mjs`；
- [ ] `asg-plugin.json` 只有允许字段，`api_version: 1`，`version` 与 tag 一致；
- [ ] `asg-plugin.json`、`package.json` 版本同步；
- [ ] `npm run typecheck`、`npm test` 通过；
- [ ] `.github/workflows/release.yml` 用 `contents: write` 并上传三个资产；
- [ ] README 写明能力、配置、安装命令与发版步骤；
- [ ] GitHub topic `asg-plugin` 已设置（发布后手动加）。

## 参考文件

- `references/manifest.md`：manifest 字段、校验规则、安装目录与资产。
- `references/fetch-plugin.md`：`FetchPlugin` 全字段、结果形状、上下文与错误约定。
- `references/search-engine.md`：`EngineProvider` 两种 runtime、routing/plan 语义、返回结构。
- `references/release.md`：构建、发布、安装器行为与常见坑。
- `examples/fetch-plugin.ts`：最小可复制 fetch 插件。
- `examples/search-engine.ts`：最小可复制 search engine。
