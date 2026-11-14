# 构建与发布

## 本地构建

```bash
npm install          # 生成 package-lock.json（随仓库提交）
npm run typecheck    # tsc --noEmit
npm test             # 构建 + vitest + node --test 冒烟
npm run build        # esbuild → index.mjs
```

`index.mjs`、`SHA256SUMS`、`node_modules/` 都在 `.gitignore` 里，不进仓库。
发布用的产物由 CI 现场构建。

## 单文件 ESM 约束

- `entry: "index.mjs"` 是**单文件**：不能 import 同目录其它文件；
- `external: ["node:*"]` 之外的依赖都必须被 bundle；
- `platform: "node"`、`target: "node22"`、`format: "esm"`；
- 不要开 code splitting，不要输出 sourcemap 到 Release；
- 若用了 `node:sqlite` 等较新内置模块，README 里注明最低 Node 版本。

## 发布步骤

1. **同步版本号**：`asg-plugin.json` 与 `package.json` 都改成 `0.1.0`；
2. 提交：`git add -A && git commit -m "chore: release v0.1.0"`；
3. 打 tag 并推送：`git tag v0.1.0 && git push origin v0.1.0`；
4. CI 会执行 `npm ci` → `npm run typecheck` → `npm test` → `npm run build`，
   然后：

```bash
sha256sum index.mjs asg-plugin.json > SHA256SUMS
gh release create "$GITHUB_REF_NAME" index.mjs asg-plugin.json SHA256SUMS \
  --title "<repo> v0.1.0" --generate-notes
```

## 资产要求

| 资产 | 必需 | 说明 |
| --- | --- | --- |
| `index.mjs` | 是 | 单文件 ESM，文件名与 manifest `entry` 一致 |
| `asg-plugin.json` | 是 | manifest |
| `SHA256SUMS` | 是 | 覆盖上面两个文件 |

安装器会：

1. 解析 GitHub Release（`v<version>` 优先，回退 `<version>`，再回退 `latest`）；
2. 下载并校验 `asg-plugin.json`；
3. 下载 `entry` 与 `SHA256SUMS`，逐个校验 sha256；
4. 失败清理 staging，成功原子换入 `data/extensions/<id>/`。

因此：**不要手工上传/替换 Release 资产**，也不要移动已发布的 tag。

## 发现

- GitHub topic：**`asg-plugin`**；
- 用户命令：

```bash
asg extensions search <关键词>
asg extensions install <owner>/<repo>@0.1.0
asg extensions list
```

## 常见坑

| 现象 | 原因 |
| --- | --- |
| 安装报 manifest 校验失败 | 多了未知字段 / `api_version` 不是 1 / `entry` 带路径 |
| 安装报版本不匹配 | tag 与 `version` 不一致（`v0.1.0` ↔ `0.1.0`） |
| 安装后插件不生效 | 网关版本未接入运行期加载；或未在 `gateway.yaml` 启用 |
| `index.mjs` 运行时找不到模块 | 有依赖没 bundle（漏了 `external` 之外的处理） |
| 插件导入了 `agent-search-gateway/...` | 运行期不保证宿主 `node_modules`，必须复制/bundle |
| `export const fetch` 后网络请求递归 | 模块内同名绑定遮蔽了全局 `fetch`，改 `globalThis.fetch` 或拆文件 |
| `asg extensions search` 搜不到 | 没加 `asg-plugin` topic，或仓库是私有的 |
| 安装器下载失败 | 资产地址不是 https / 私有仓库鉴权限制 |

## 发版检查

- [ ] `npm run typecheck`、`npm test`、`npm run build` 全绿；
- [ ] `asg-plugin.json`、`package.json` 版本一致且等于 tag（去掉 `v`）；
- [ ] Release 三个资产齐全，`SHA256SUMS` 可校验；
- [ ] README 写清能力、配置示例、安装命令、最低 Node 版本；
- [ ] 仓库 topic `asg-plugin` 已设置。
