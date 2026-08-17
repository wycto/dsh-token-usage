# DSH Token 用量记录与统计插件 — 设计方案

## 目标
在 DSH 中使用过的所有 API 调用（LLM 模型请求），提供记录、查询、统计。
单页面全屏打开，按秒粒度时间范围查询，支持多维度筛选与分组统计。

## 数据来源（DSH 运行时内建，无需侵入式 hook）
所有数据来自**会话日志事件**（`dsh-session` 的 `SessionEvent`），经 `Session` 可持久化、可回放：

| 需求字段 | 来源事件 | 字段路径 |
|---|---|---|
| 时间 | 事件 `time` | 每个事件的 Unix epoch ms，秒级精确 |
| 模型提供商 | `request/context` | `provider`（路由名，如 ocx） |
| 模型 | `request/context` | `model` |
| apikey | provider 配置 `apiKeyEnv` 环境变量 | `~/.dsh/settings.yaml` 读取 provider 的 `apiKeyEnv`，展示掩码 `sk-***last4`（不落明文） |
| Token 数量 | `assistant/message.usage` | `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` |
| 缓存命中量 | 同上 | `cacheReadTokens` |
| 缓存命中百分比 | 官方公式 | `cacheRead/(uncachedInput+cacheRead)` |
| 消耗金额 | 内置定价表估算 | `(uncachedInput×inPrice + cacheRead×cachePrice + output×outPrice)/1e6` |
| 推理强度 | `request/header.config` | `reasoningEffort` |
| 状态 | `turn/end.reason` | `completed/aborted/blocked/error/max-tokens/...` |
| 耗时 | `step/start`→`assistant/message` 时间差 | `llmMs`（与官方 sessionStats 一致） |

## 架构
```
┌─ Host (Node) ─────────────────────────────────────────┐
│  collector:                                          │
│    • 启动时全量扫描历史会话日志 → 建立内存索引        │
│    • 运行时监听 session/event → 增量追加              │
│  store: 会话日志本身即持久化存储(DSH 持久数据源),     │
│    插件只维护内存索引; 进程重启后自动重扫重建          │
│  query: 按 [时间范围] × [provider/model/status/       │
│        apikey] 过滤 + 分组统计 + CSV                │
│  harness.handle('token-usage.query' | 'scan' |        │
│        'export' | 'hello')                           │
└──────────────────────────────────────────────────────┘
┌─ Client (Browser) ───────────────────────────────────┐
│  sidebar.footer.action 入口按钮                        │
│  shell.overlay 全屏工作台(可开关)                     │
│  • 筛选栏：时间(秒级 datetime-local)、provider、      │
│    model、状态、推理强度                               │
│  • 明细表格(分页) + 统计汇总表(按维度分组)            │
│  • CSV 导出 / 刷新                                     │
└──────────────────────────────────────────────────────┘
```

> 注：为何不用 `storageDomain` 自建持久化——动态 Cordis 插件无法 import `defineDomain`
> 工厂（纯函数体无模块系统），且会话日志本身已是可回放的持久数据源；
> 内存索引 + 启动重扫 是最简且数据强一致的方案。

## 定价表（内置，用户可覆盖）
策略：常见模型已知单价（USD/1M tokens）；未知模型 fallback 估算。
`settings.yaml` 的 `token-usage.pricing`（map: modelPattern → { input, output, cacheRead, cacheWrite }）覆盖内置表。
费用是**估算值**，UI 标注"估算"。

## 安全
- apiKey 永不落盘：仅记录掩码（前 3 字符 + *** + 后 4 字符，取决于结构）。
- 记录存 `~/.dsh/storages/`（DSH 的 domain 存储），本地明文 JSON，同凭据同目录，符合 DSH 现状。

## 待确认 / 风险
- storageDomain 的 domain 需 `defineDomain` 声明 schema；若在纯动态插件里无法声明，降级为 AppData 独立 JSON 文件（fs 写入）。
- 历史会话扫描可能较大（本机已有 20+ 会话，单会话 5 万~18 万事件），需分页/并发 + 只取相关事件类型。
- 上游 OCX 是网关卡（baseURL 127.0.0.1:10100），usage 字段若有则取，无则显示 0/N/A。