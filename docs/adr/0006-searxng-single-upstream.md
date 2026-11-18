# 网关保留 searxng 单一上游，外部搜索基础设施作为其引擎接入

> **部分由 ADR-0023 修订**：general 查询新增网关原生通用上游
> `gateway.upstream:deepseek`，与 searxng 并发并由网关融合候选。本文的「外部搜索
> 基础设施作为 searxng 引擎接入」仍适用于 Exa/Tavily 一类来源；「单一上游」不再是
> 绝对约束，详见 ADR-0023。

Exa 等 AI 搜索基础设施不在网关内做 provider 抽象，而是作为 searxng 的引擎接入；轮换、限流、API 切换都由 searxng 内部承担。网关的搜索边界保持 `searchSearxng` 单一上游不变。

## Considered Options

- **网关内多 provider 端口 + Router**：能表达主备/融合/调用方选，但需引入能力位、跨 provider 去重与排序，复杂度过高；被否。
- **调用方选 provider**：契约更明确，但把轮换责任推给 agent；被否。

## Consequences

- 网关无法感知单个结果来自 Exa 还是别的引擎，也无法据此跳过重排。
- 上游的可用性与轮换不在网关控制内；语料召回恒开，不因上游失败而单独触发。
