# DeepSeek 通用搜索上游：网关侧第二个通用检索出口

- 状态：已接受
- 日期：2026-11-18
- 相关：ADR-0006（searxng 单一上游）、ADR-0008（显式类别抑制常驻/轮换）、
  ADR-0010（以图搜图附加源）、`docs/engine-provider.md`、`docs/cli-contract.md`

## 背景（Context）

ADR-0006 把网关的搜索边界收在 `searchSearxng` 单一上游内，外部搜索基础设施作为
searxng 的引擎接入；ADR-0010 又为「类别触发、只产出候选」的附加源开了一个窄例外。
这两类出口都不能覆盖一个场景：**普通 general 查询也需要第二个通用搜索来源**。

DeepSeek 同时提供两种可用的通用搜索入口：

- **Search API**（`POST /search`）：一次请求直接返回排序后的网页结果，带官方
  `rerank_score`；
- **Harness**（Anthropic Messages 形状 + 服务端 `deepseek_web_search` 工具）：由模型
  决定是否发起搜索，结果以 `web_search_tool_result` 内容块返回。

它与 searxng 的差异不在类别，而在**来源与分数量纲**：searxng 内部聚合多家引擎并按自己
的算法给 `score`，DeepSeek 的两种模式一个给官方分、一个完全不给分。因此不能像附加源
那样只把候选并入现有管线，必须定义**跨源融合规则**。

约束：

- 不新增 MCP 工具，不新增搜索参数；调用方无感知；
- 只在 general 查询参与，不做类别路由；
- 失败静默降级，不能因为 DeepSeek 不可用而让整个搜索失败；
- 不把 DeepSeek 变成 searxng 的硬依赖，也不替换 searxng。

## 决策（Decision）

1. **新增引擎组 `gateway.upstream`，内置 provider `gateway.upstream:deepseek`。**

   `EngineGroup` 增加 `gateway.upstream`，语义是「网关直接调用、与 searxng 并发、
   只产出通用类别候选的上游」。它不是 searxng 引擎，也不是独立 MCP 工具；CLI 与运行期
   仍走现有 provider 注册表。

   provider 声明 `routing: () => ["general"]`、`requires:
   ["secrets.search.deepseek.api_key"]`，启用状态路径为
   `["search", "deepseek", "enabled"]`。运行期实现是新的
   `GatewayUpstreamRuntime`：

   ```ts
   interface GatewayUpstreamOptions {
     limit: number;
     minScore?: number;
     language?: string;
     safeSearch?: string;
   }

   interface GatewayUpstreamRuntime {
     kind: "upstream";
     search(
       query: string,
       options: GatewayUpstreamOptions,
       ctx: EngineProviderContext,
     ): Promise<GatewaySearchResult>;
   }
   ```

2. **配置放在 `search.deepseek`，默认关闭、默认 `raw`。**

   - `enabled: false`；
   - `mode: raw | harness`；
   - `limit`（默认 10，上限 50）；
   - `api`：`base_url`（默认 `https://api.deepseek.com/v1/tools`）、`need_content`、
     `localization`、`timeout_ms`；
   - `harness`：`base_url`（默认 `https://api.deepseek.com/anthropic/v1`）、`model`
     （默认 `deepseek-flash`）、`max_tokens`、`api_version`、`timeout_ms`。

   密钥只放 `secrets.yaml → search.deepseek.api_key`，也支持
   `DEEPSEEK_API_KEY` 环境变量覆盖；`env:` 引用在运行期解析。

3. **两种模式共用同一条「上游 → 候选」契约，但请求形态不同。**

   **raw**：

   - `POST {base_url}/search`，`Authorization: Bearer <key>`；
   - body 为 `{ query, count, need_content }`，`count = min(limit, 50)`，query 截断到
     128 个字符；`localization` 非空时才发送；
   - 映射：默认 `content = summary || snippet || content`，`need_content: true` 时优先
     `content`；`score = clamp(rerank_score / 3, 0, 1)`，缺失时 `0.5`；标题回退
     `site_name`，再回退 URL host；`engine = "deepseek"`、`category = "general"`；
   - 官方分在**源内**排序，并按 `rerank_score / 3 >= minScore` 过滤，再截断到 `limit`。

   **harness**：

   - `POST {base_url}/messages`，同时带 `x-api-key` 与 `Authorization: Bearer`、
     `anthropic-version`；body 使用 `messages` + `tools: [{ type:
     "deepseek_web_search", name: "deepseek_web_search" }]`，并关闭 thinking；
   - 只读取 `content[]` 里 `type === "web_search_tool_result"` 的块，逐项取
     `web_search_result`；标题回退同上，正文优先 `snippet`，缺失时用 citation 的
     `cited_text`；
   - 结果**不设置 `score`**，因此不参与 `min_score` 过滤；`engine =
     "deepseek_harness"`、`category = "general"`；
   - 没有出现 `web_search_tool_result` 视为 api 错误，而不是空结果。

   两种模式都把 HTTP 401/403 归为 `auth`，402/429/其它非 2xx 归为 `api`（402 提示余额
   不足、429 提示限流），超时归为 `timeout`，非 JSON 归为 `invalid`，网络异常归为
   `network`；失败一律返回 `{ ok: false, error, latencyMs }`，不抛裸异常。

4. **参与条件严格收窄。**

   以下条件全部满足时才调用 DeepSeek：

   1. `search.deepseek.enabled === true`；
   2. provider `available()` 为 true（解析 `env:` 后 API key 非空）；
   3. 不是反向图搜；
   4. `query.trim() !== ""`；
   5. `categories` 为空，或规范化后只有 `general`；
   6. 没有显式 `engines`。

   因此它只增强「普通关键词搜索」，不影响图片、以图搜图、微博/热搜、学术等显式类别，
   也不与调用方点名的引擎混用。

5. **与 searxng 并发，失败静默降级。**

   DeepSeek 与 searxng 批次同时启动、同时等待。任一源失败只在结果末尾追加一条说明
   （`DeepSeek 上游不可用（<kind>）——<message>；以下结果不含 DeepSeek。`）；启用但未
   配置 key 时提示已跳过。只有 searxng 与所有通用上游都失败才进入错误路径；任一方是
   `auth` 时优先返回 `SEARCH_AUTH_REQUIRED`。缓存键包含本次启用的通用上游 id；降级结果
   不写搜索缓存，避免把临时故障固化。

6. **多上游融合：源内名次归一化 + URL 合并 + `engine_boost` 加权。**

   - 每个源先清洗（searxng 仍应用全局 `min_score`；raw 在 provider 内已按源内
     `min_score` 过滤；harness 不过滤），再做**源内名次归一化**：第 1 名 `1.0`，第 2
     名 `(n - 1) / n`，最后一名 `1 / n`；
   - 按规范化 URL 去重合并：`engines` 取并集，`content` / `title` /
     `publishedDate` 空则补齐，`score` 取较大值；
   - 最终按 `score × engine_boost` 稳定降序；`engine_boost` 的键先看 `engines`，再看
     `engine`，与现有 `rerankResults` 一致；
   - 多上游分支不再调用一次 `rerankResults`，避免二次 boost。之后照常进入语义层
     （embedding / 语料召回 / 多样性 / 权威），失败时回退到加权排序。

   评分细节：

   - **raw 的官方 `rerank_score` 只用于源内排序和源内 `min_score`**，不跨源直接比较；
   - **harness 没有原始分**，不参与 `min_score`，但仍通过名次归一化获得与其他源同尺度
     的分数；
   - `engine_boost` 是唯一跨源的用户可调权重。

7. **CLI 与观测面沿用现有控制面。**

   - `asg engines list/enable/disable/secret` 支持
     `gateway.upstream:deepseek`；`secret` 写
     `secrets.yaml → search.deepseek.api_key`；
   - `asg engines route` **不支持**通用上游，报 `ENGINE_NO_ROUTING`（退出码 4），用
     enable/disable 控制；
   - `SearchMetrics.generalUpstreams` 记录每个通用上游的 `id / ok / results / ms /
     error`，仅在多上游分支填充。

8. **明确不做的事。**

   - 不新增 MCP 工具或搜索参数；
   - 不做 DeepSeek 图片搜索，也不接 DeepSeek 的 Fetch API；
   - v1 不向第三方插件开放 `gateway.upstream`，该组只内置 `deepseek`。

## 后果（Consequences）

正面：

- general 查询多了一个独立来源，searxng 被限流、缺引擎或结果偏差时仍能补召回。
- 调用方无感知：工具、参数、错误码边界都不变。
- raw 模式延迟低、按成功请求计费；harness 复用模型侧搜索能力，适合需要模型筛选的场景。
- 名次归一化让「有官方分」和「没有分」的源可以同尺度融合，且保留 `min_score` 与
  `engine_boost` 的既有语义。

代价与风险：

- 多一次外部请求与一份 API key 的保管责任；默认关闭，需用户显式开启。
- raw 约 **$0.75 / 1000 次成功请求**，空结果不计费；harness 搜索本身不额外计费，但每次
  消耗模型 token，且延迟明显更高。
- harness 的结果质量依赖模型是否触发服务端搜索；没有 `web_search_tool_result` 会按
  api 错误降级，而不是当作空结果。
- 名次归一化会抹平源内分差：同一源第 1 名与第 2 名的差距被固定为 `1/n`，不再反映
  raw 官方分的高低。这是为了跨源可比而接受的取舍。
- 两个源都失败时错误文本会更长（同时包含 searxng 与 DeepSeek 的原因）。

## 替代方案（Alternatives）

- **把 DeepSeek 做成 searxng 引擎**：searxng 引擎是 Python 侧实现，需要移植请求、
  鉴权、错误分类与配额；网关拿不到原始结果做源内归一化，也无法独立控制「DeepSeek
  失败但 searxng 继续」的降级粒度。被否。
- **仅按类别触发（如 `categories=deepseek`）**：与附加源同构，但要求调用方改请求，
  general 查询永远用不上第二来源；还会把「通用搜索」错误地表达成一个类别。被否。
- **用 DeepSeek 替换 searxng**：会丢掉现有引擎、隐私边界与自托管能力，且 DeepSeek
  不可用时没有兜底；与 ADR-0006 的稳定边界冲突。被否。
- **做成独立 MCP 工具或新增搜索参数**：把选择责任推给 agent，破坏工具契约稳定性，
  也让缓存、限流、降级与语义层各自分叉。被否。
- **只做 searxng 失败后的备源**：实现简单、成本低，但正常查询拿不到第二来源的召回，
  且失败后才串行请求会放大尾延迟；与「并发 + 融合」的目标不符。被否。
- **RRF（Reciprocal Rank Fusion）**：只依赖名次、不需要分数量纲，鲁棒性好；但会丢掉
  raw 官方 `rerank_score` 的源内信息，也无法自然表达 `min_score`，最终分与现有
  `score × engine_boost` 管线不一致。被否。
- **直接混合原始分**：raw 的 `rerank_score` 是 0–3 量纲、harness 没有分，searxng 的
  `score` 又是另一套算法；直接比较会让某一个源系统性占优。被否。
- **选择名次归一化的理由**：它只要求「每个源能给出顺序」，正好同时覆盖 raw、harness
  与 searxng；第 1 名恒为 `1.0`，避免某个源因分数量纲更大而霸榜；实现是确定性的、
  稳定的，且保留 `min_score`（源内）与 `engine_boost`（跨源）两个已有旋钮。代价是
  源内分差被压缩，已在「后果」中记录。
