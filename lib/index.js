/**
 * dsh-token-usage — Host 端
 *
 * 记录 DSH 会话日志中的每次 LLM 调用(assistant/message 的 usage),
 * 支持历史全量扫描 + 实时 session/event 增量。
 * 通过 Package-private RPC (harness.handle) 向 Client 提供查询/统计/导出。
 *
 * 数据模型(标量, 无 Host 对象引用):
 * {
 *   id, time, sessionId, provider, model, apiKey(掩码),
 *   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
 *   billedInput, totalTokens, cacheHitPercent, cost, effort, status, llmMs, turn, step
 * }
 */

export const name = 'dsh-token-usage'

export const Config = {
  // Schemastery schema 占位; 完整实现请接 z.object({ pricing: z.record(...) })
}

export function apply(ctx) {
  let records = []
  let scannedSessions = new Set()
  const headerCache = new Map()
  const turnError = new Map()
  const turnStatus = new Map()
  const stepStart = new Map()

  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

  // 内置定价表(USD / 1M tokens), 按 model 子串匹配; 未匹配走 fallback。
  const DEFAULT_PRICING = [
    { match: 'deepseek-v4-flash', input: 0.25, output: 0.5, cacheRead: 0.05, cacheWrite: 0.8 },
    { match: 'deepseek-v3', input: 0.5, output: 1.0, cacheRead: 0.1, cacheWrite: 1.0 },
    { match: 'deepseek-chat', input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 1.1 },
    { match: 'deepseek-reasoner', input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 1.1 },
    { match: 'nemotron', input: 0.15, output: 0.4, cacheRead: 0.03, cacheWrite: 0.3 },
    { match: 'glm', input: 0.4, output: 1.2, cacheRead: 0.08, cacheWrite: 1.0 },
  ]
  function resolvePricing(model) {
    const m = String(model || '').toLowerCase()
    for (const row of DEFAULT_PRICING) {
      if (m.includes(row.match)) return row
    }
    return { match: '*', input: 0.3, output: 0.9, cacheRead: 0.06, cacheWrite: 0.6 }
  }
  function estimateCost(usage, model) {
    const p = resolvePricing(model)
    return (
      num(usage.inputTokens) * p.input +
      num(usage.cacheReadTokens) * p.cacheRead +
      num(usage.cacheWriteTokens) * p.cacheWrite +
      num(usage.outputTokens) * p.output
    ) / 1e6
  }

  // 处理一个会话事件, 生成一条记录(若无 usage 返回 null)
  // ---------- 事件采集 ----------

  // 预扫描 turn/end: 先建立 turn -> status/error 映射, 再生成记录
  // (解决顺序处理导致的状态缺失: assistant/message 先于 turn/end 到达)
  function preScanTurnEnds(sessionId, events) {
    for (const e of events) {
      if (e.type !== 'turn/end') continue
      const t = e.data && e.data.turn
      const r = e.data && e.data.reason
      let status = 'completed'
      if (r && typeof r === 'object') status = r.kind || 'completed'
      else if (typeof r === 'string') status = r
      turnStatus.set(sessionId + ':' + t, status)
      let errInfo = null
      if (r && typeof r === 'object' && r.error) {
        const er = r.error
        errInfo = {
          statusCode: typeof er.status === 'number' ? er.status : 0,
          errorCode: er.code || '',
          errorMsg: er.message || '',
        }
      }
      turnError.set(sessionId + ':' + t, errInfo)
    }
  }

  function ingestEvent(sessionId, event) {
    if (event.type === 'request/header') {
      const h = event.data && event.data.header
      if (h && h.config) {
        headerCache.set(sessionId, {
          provider: h.config.provider || '',
          model: h.config.model || '',
          effort: h.config.reasoningEffort || '',
        })
      }
    }
    if (event.type === 'turn/end') {
      const t = event.data && event.data.turn
      const r = event.data && event.data.reason
      let status = 'completed'
      if (r && typeof r === 'object') status = r.kind || 'completed'
      else if (typeof r === 'string') status = r
      turnStatus.set(sessionId + ':' + t, status)
      let errInfo = null
      if (r && typeof r === 'object' && r.error) {
        const e = r.error
        errInfo = {
          statusCode: typeof e.status === 'number' ? e.status : 0,
          errorCode: e.code || '',
          errorMsg: e.message || '',
        }
      }
      turnError.set(sessionId + ':' + t, errInfo)
    }
    if (event.type === 'step/start') {
      stepStart.set(sessionId + ':' + event.data.turn + ':' + event.data.step, event.time)
    }
    if (event.type !== 'assistant/message') return null
    const d = event.data || {}
    let usage = d.usage
    if (!usage || typeof usage !== 'object') usage = { inputTokens: 0, outputTokens: 0 }
    const head = headerCache.get(sessionId) || { provider: '', model: '', effort: '' }
    const turn = num(d.turn)
    const step = num(d.step)
    const startK = sessionId + ':' + turn + ':' + step
    const startMs = stepStart.get(startK)
    const llmMs = typeof startMs === 'number' ? Math.max(0, event.time - startMs) : null
    const status = turnStatus.get(sessionId + ':' + turn) || 'in-progress'
    const ei = turnError.get(sessionId + ':' + turn) || null
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    const reasoning = num(usage.reasoningTokens)
    const cost = estimateCost(usage, head.model)
    stepStart.delete(startK)
    return {
      id: sessionId + ':' + event.seq,
      time: event.time,
      sessionId,
      provider: head.provider || '',
      model: head.model || '',
      apiKey: '',
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      billedInput: input + cacheRead + cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cacheHitPercent: (input + cacheRead) > 0 ? Math.round((cacheRead / (input + cacheRead)) * 100) : 0,
      cost,
      effort: head.effort || '',
      status,
      statusCode: ei ? ei.statusCode : 0,
      errorCode: ei ? ei.errorCode : '',
      errorMsg: ei ? ei.errorMsg : '',
      llmMs,
      turn,
      step,
    }
  }

  function ingestEvents(sessionId, events) {
    const out = []
    for (const e of events) {
      const r = ingestEvent(sessionId, e)
      if (r) out.push(r)
    }
    return out
  }

  // 实时监听: session/event (root scope 可收到所有 session 事件)
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery) {
    ctx.on('session/event', (session, event) => {
      try {
        const sid = typeof session === 'object' && session ? (session.id || '') : String(session || '')
        const rec = ingestEvent(sid, event)
        if (rec) records.push(rec)
        // turn/end 到达后回填该 turn 已有记录的状态/错误(实时增量场景)
        if (event.type === 'turn/end') {
          const t = event.data && event.data.turn
          const key = sid + ':' + t
          const st = turnStatus.get(key)
          const ei = turnError.get(key) || null
          if (st) {
            for (const r of records) {
              if (r.sessionId === sid && String(r.turn) === String(t)) {
                r.status = st
                r.statusCode = ei ? ei.statusCode : 0
                r.errorCode = ei ? ei.errorCode : ''
                r.errorMsg = ei ? ei.errorMsg : ''
              }
            }
          }
        }
      } catch (err) {
        console.error('[token-usage] ingest error', err)
      }
    })
  }

  // 历史扫描: 遍历所有会话, 读取完整日志, 重建索引
  async function scanHistory() {
    if (!sessionQuery) return
    try {
      const sessions = await sessionQuery.listSessions()
      let added = 0
      for (const s of sessions) {
        const sid = s && s.header ? s.header.id : (s && s.id)
        if (!sid || scannedSessions.has(sid)) continue
        scannedSessions.add(sid)
        try {
          const snap = await sessionQuery.readSession(sid)
          const events = snap && snap.events ? snap.events : []
          // 两遍: 先建 turn/end 映射, 再生成记录
          preScanTurnEnds(sid, events)
          const recs = ingestEvents(sid, events)
          records.push(...recs)
          added += recs.length
        } catch (e) {
          console.error('[token-usage] scan session failed', sid, e && e.message)
        }
      }
      records.sort((a, b) => a.time - b.time)
      console.log('[token-usage] history scanned: ' + added + ' records, total ' + records.length)
    } catch (e) {
      console.error('[token-usage] scanHistory failed', e && e.message)
    }
  }

  function buildQuery(args) {
    const q = args || {}
    const from = typeof q.from === 'number' ? q.from : 0
    const to = typeof q.to === 'number' ? q.to : Infinity
    const provider = (q.provider || '').trim()
    const model = (q.model || '').trim()
    const status = (q.status || '').trim()
    const effort = (q.effort || '').trim()
    const sessionId = (q.sessionId || '').trim()
    return records.filter((r) => {
      if (r.time < from || r.time > to) return false
      if (provider && r.provider !== provider) return false
      if (model && r.model !== model) return false
      if (status && r.status !== status) return false
      if (effort && r.effort !== effort) return false
      if (sessionId && r.sessionId !== sessionId) return false
      return true
    })
  }

  function summarize(list, dim) {
    const map = new Map()
    for (const r of list) {
      const key = r[dim] || '(none)'
      const e = map.get(key)
      if (e) {
        e.calls += 1
        e.inputTokens += r.inputTokens
        e.outputTokens += r.outputTokens
        e.cacheReadTokens += r.cacheReadTokens
        e.cacheWriteTokens += r.cacheWriteTokens
        e.reasoningTokens += r.reasoningTokens
        e.billedInput += r.billedInput
        e.totalTokens += r.totalTokens
        e.cost += r.cost
        if (typeof r.llmMs === 'number') { e.llmMs += r.llmMs; e.timed += 1 }
      } else {
        map.set(key, {
          key, calls: 1,
          inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
          reasoningTokens: r.reasoningTokens, billedInput: r.billedInput,
          totalTokens: r.totalTokens, cost: r.cost,
          llmMs: typeof r.llmMs === 'number' ? r.llmMs : 0,
          timed: typeof r.llmMs === 'number' ? 1 : 0,
        })
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, cacheHitPct: e.billedInput > 0 ? Math.round((e.cacheReadTokens / e.billedInput) * 100) : 0 }))
      .sort((a, b) => b.calls - a.calls)
  }

  function totals(list) {
    const t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, billedInput: 0, totalTokens: 0, cost: 0, llmMs: 0, timed: 0 }
    for (const r of list) {
      t.calls += 1
      t.inputTokens += r.inputTokens
      t.outputTokens += r.outputTokens
      t.cacheReadTokens += r.cacheReadTokens
      t.cacheWriteTokens += r.cacheWriteTokens
      t.reasoningTokens += r.reasoningTokens
      t.billedInput += r.billedInput
      t.totalTokens += r.totalTokens
      t.cost += r.cost
      if (typeof r.llmMs === 'number') { t.llmMs += r.llmMs; t.timed += 1 }
    }
    t.cacheHitPct = t.billedInput > 0 ? Math.round((t.cacheReadTokens / t.billedInput) * 100) : 0
    return t
  }

  // ---------- RPC ----------
  harness.handle('token-usage.query', async (args) => {
    const list = buildQuery(args)
    const rows = [...list].sort((a, b) => b.time - a.time)
    return {
      records: rows,
      counts: { total: records.length, matching: rows.length },
      providers: [...new Set(records.map((r) => r.provider).filter(Boolean))],
      models: [...new Set(records.map((r) => r.model).filter(Boolean))],
      statuses: [...new Set(records.map((r) => r.status).filter(Boolean))],
      efforts: [...new Set(records.map((r) => r.effort).filter(Boolean))],
      sessionIds: [...new Set(records.map((r) => r.sessionId).filter(Boolean))].sort(),
      totals: totals(list),
      summary: args && args.dim ? summarize(list, args.dim) : [],
    }
  })

  harness.handle('token-usage.export', async (args) => {
    const list = buildQuery(args)
    const header = ['time', 'provider', 'model', 'apiKey', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'billedInput', 'cacheHitPercent', 'totalTokens', 'cost', 'effort', 'status', 'statusCode', 'errorCode', 'errorMsg', 'llmMs', 'sessionId', 'turn', 'step']
    const esc = (v) => {
      const s = String(v === undefined || v === null ? '' : v)
      return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const lines = [header.map(esc).join(',')]
    for (const r of list) lines.push(header.map((h) => esc(r[h])).join(','))
    return { csv: lines.join('\n'), count: list.length }
  })

  harness.handle('token-usage.scan', async () => {
    await scanHistory()
    return { total: records.length }
  })

  harness.handle('token-usage.hello', async () => {
    return { ok: true, records: records.length, scanned: scannedSessions.size }
  })

  // 启动时后台扫描
  scanHistory()
}
