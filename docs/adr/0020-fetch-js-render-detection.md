# fetch 的 JS 渲染按正文判断，不按 HTML 体积

`fetch` 早期用「HTML 小于 2000 字节且含 script src」判断 SPA 空壳。现代 SPA 首屏 HTML 常是 170KB–1.8MB（抖音、小红书、Threads），这个条件几乎永远不成立：direct 拿到空壳，`htmlToMarkdown` 去掉 script 后正文为空，却被当成成功返回，CLI 退出码 0。

社区没有可信的「JS 渲染域名名单」：RSSHub 的 `features.requirePuppeteer` 是路由级元数据，Wappalyzer/BuiltWith 只能识别框架（Next/Nuxt 也可 SSR），HTTP Archive 没有「正文是否依赖 JS」字段。JS 需求还是 URL 级、随登录态/地区/实验变化，名单必然过期。

因此判据改为**转换后的正文**：去掉图片、链接 URL、标点与空白后统计可见字符；正文为 0 且有 script/noscript，或正文 < 200 且（SPA 挂载点 / 无正文节点 / 密度 < 1 字符/KB）且有外链脚本时，升级浏览器。CF 挑战页单独识别，走 FlareSolverr。

## Decision

- `fetch` 新增 `render: auto | always | never`，默认 `auto`；`always` 不受内容判断和 `flaresolverr.fallback_on_empty` 影响。
- `auto` 命中后优先本地 playwright，失败再 FlareSolverr；403/405/429 仍保持 FlareSolverr 优先。
- 同时保留 direct 与渲染结果，按可见正文长度取更长者；误判只多花一次渲染，不丢正文。
- 渲染后仍无正文返回 `[FETCH_RENDER_FAIL]`，不再用空字符串表示成功。
- `data:` URI 图片不直接塞进正文：落盘到产物目录并替换成 `/files/<id>` 链接（单张 2MB、单次 10MB / 20 张），避免 base64 占满上下文。
- `render` 只影响 fetch 返回的 markdown，不接管 `browser_*` 会话。

## Considered Options

- **维护域名/路由名单**：需要持续跟进站点改版，且无法表达同域名下文章 SSR、搜索 CSR；被否。
- **永远浏览器优先（Firecrawl 托管版 / Crawl4AI）**：正确率最高，但本地只有 1–2 个 Chromium 和 FlareSolverr 进程级闸门，普通页面会被拖慢；被否。
- **只看 HTML 体积**：实现简单，但正是本次缺陷的来源；被否。
- **渲染后仍空时返回空字符串**：调用方无法区分「页面就是空」和「没渲染出来」；被否。

## Consequences

- `auto` 仍是启发式；阈值（200 字符 / 1 字符每 KB）写在 `src/fetch/content.ts`，需要时再调。
- 自动升级受 `flaresolverr.fallback_on_empty` 控制；显式 `render=always` 始终可用。
- 首轮 playwright 需要拉起 Chromium，耗时可能 1–2s；后续渲染通常 1s 出头，`networkidle` 与正文轮询都有上限。
- 登录墙/强反爬页面即使渲染也拿不到正文，此时返回 `FETCH_RENDER_FAIL` 并提示，而不是假装成功。
