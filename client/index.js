/**
 * dsh-token-usage — Client 端(web) v5
 *
 * 单窗口全屏统计面板:
 *  - sidebar.footer.action 入口按钮 "Token 用量"(醒目大按钮)
 *  - shell.overlay 全屏工作台(可开关)
 *  - 秒级时间范围查询 + 会话ID/provider/model/状态/推理强度 筛选
 *  - 明细表可点击表头排序, 会话ID可点击筛选
 *  - 状态列显示 HTTP 状态码(200/400/499/403/500…), 下方【查看详情】弹窗展示完整信息
 *  - 分组统计表 + CSV 导出
 *
 * 通过 host.call('token-usage.*') 调用 Host RPC。
 * 注意: 这是源码, 发布时用 tsdown 打包为 exports["./client"] 的 closure-factory。
 * (动态 extensions 场景直接作为 client half 运行, 用 React.createElement + 全局 React/styles/host。)
 */
import { useState, useEffect, useCallback, useMemo } from 'react'

// ---------- Host RPC 桥接(静态插件) ----------
// dsh rc.6 静态插件没有 host 全局; 通过 ctx.connection.rpc.call 调用 Host。
// apply(ctx) 里从 ctx.connection 初始化, 组件内统一用 rpcCall(method, args)。
let _conn = null
function rpcCall(method, args) {
  if (!_conn || !_conn.rpc || typeof _conn.rpc.call !== 'function') {
    return Promise.reject(new Error('connection 服务不可用(插件未初始化)'))
  }
  return _conn.rpc.call('/api', 'token-usage/' + method, args === undefined ? null : args)
    .then((res) => {
      if (res && res.ok === true) return res.data
      if (res && res.ok === false) throw new Error((res.error && res.error.message) || 'RPC 调用失败')
      return res
    })
}

// 全局开关状态(模块级, 两个入口共享)
let panelOpen = false
const listeners = new Set()
function setPanelOpen(v) { panelOpen = !!v; for (const fn of listeners) fn(panelOpen) }
function usePanelOpen() {
  const [open, setOpen] = useState(panelOpen)
  useEffect(() => {
    const fn = (v) => setOpen(v)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])
  return open
}

function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-US') }
function fmtCompact(n) {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtCost(n) {
  const v = Number(n) || 0
  if (v >= 10) return '$' + v.toFixed(2)
  if (v >= 0.01) return '$' + v.toFixed(4)
  return '$' + v.toFixed(6)
}
function fmtDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
}
function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function toLocalInput(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function shortId(sid) {
  if (!sid) return ''
  if (sid.length <= 16) return sid
  return sid.slice(0, 8) + '…' + sid.slice(-6)
}
function statusInfo(r) {
  if (r.status === 'completed') return { code: 200, label: '200', cls: 'ok', title: '成功' }
  if (r.status === 'max-tokens') return { code: 200, label: '200', cls: 'warn', title: '完成(达到输出上限)' }
  if (r.status === 'error') return { code: r.statusCode || 500, label: String(r.statusCode || 500), cls: 'err', title: r.errorMsg || r.errorCode || '调用失败' }
  if (r.status === 'aborted') return { code: 499, label: '499', cls: 'warn', title: '已取消' }
  if (r.status === 'blocked') return { code: 403, label: '403', cls: 'warn', title: '已阻止' }
  if (r.status === 'interrupted') return { code: 500, label: '500', cls: 'warn', title: '中断' }
  return { code: 0, label: '…', cls: 'pend', title: '进行中' }
}

const css = `
.tokuse-overlay { position: fixed; inset: 0; z-index: 9999; background: var(--tokuse-bg, rgba(16,18,24,0.96)); color: var(--tokuse-fg, #e8eaf0); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; backdrop-filter: blur(6px); }
.tokuse-header { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--tokuse-border, #2a2f3a); background: var(--tokuse-header, rgba(20,23,30,0.97)); flex-wrap: wrap; }
.tokuse-title { font-size: 16px; font-weight: 700; }
.tokuse-close { margin-left: auto; cursor: pointer; border: 0; border-radius: 8px; background: var(--tokuse-btn, #333a47); color: inherit; padding: 8px 16px; font-size: 13px; }
.tokuse-close:hover { background: #444c5c; }
.tokuse-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 18px; border-bottom: 1px solid var(--tokuse-border, #2a2f3a); background: var(--tokuse-header, rgba(20,23,30,0.9)); }
.tokuse-filter label { font-size: 12px; color: var(--tokuse-dim, #9aa3b5); }
.tokuse-input, .tokuse-select { background: var(--tokuse-input, #232936); color: inherit; border: 1px solid var(--tokuse-border, #3a4150); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
.tokuse-btn { cursor: pointer; border-radius: 6px; border: 1px solid var(--tokuse-border, #3a4150); background: var(--tokuse-btn, #2c3342); color: inherit; padding: 6px 12px; font-size: 12px; }
.tokuse-btn:hover { background: var(--tokuse-btn-hover, #39425a); }
.tokuse-btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.tokuse-btn.primary:hover { background: #3a7bfc; }
.tokuse-body { flex: 1; overflow: auto; padding: 12px 18px 80px; }
.tokuse-cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.tokuse-card { background: var(--tokuse-card, #1c212b); border: 1px solid var(--tokuse-border, #2a2f3a); border-radius: 10px; padding: 10px 16px; min-width: 120px; }
.tokuse-card .v { font-size: 20px; font-weight: 700; }
.tokuse-card .l { font-size: 11px; color: var(--tokuse-dim, #9aa3b5); margin-top: 2px; }
.tokuse-section-title { font-size: 13px; font-weight: 600; margin: 16px 0 8px; }
.tokuse-table-wrap { overflow: auto; border: 1px solid var(--tokuse-border, #2a2f3a); border-radius: 10px; }
.tokuse-table { border-collapse: collapse; width: 100%; font-size: 12px; white-space: nowrap; }
.tokuse-table th { background: var(--tokuse-header, #222836); color: var(--tokuse-dim, #9aa3b5); text-align: left; padding: 8px 10px; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--tokuse-border, #2a2f3a); font-weight: 600; user-select: none; cursor: pointer; }
.tokuse-table th:hover { color: #cfe0ff; }
.tokuse-table td { padding: 7px 10px; border-bottom: 1px solid rgba(122,132,152,0.12); }
.tokuse-table tr:hover td { background: rgba(80,110,180,0.12); }
.tokuse-empty { text-align: center; color: var(--tokuse-dim, #9aa3b5); padding: 40px 0; font-size: 13px; }
.tokuse-launcher { cursor: pointer; border: 1px solid var(--tokuse-border, #3a4150); background: linear-gradient(180deg, #2f6fed, #2459c8); color: #fff; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border-radius: 8px; font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(47,111,237,0.35); white-space: nowrap; }
.tokuse-launcher:hover { background: linear-gradient(180deg, #3a7bfc, #2a64dc); }
.tokuse-status { font-size: 12px; color: #7ab8ff; }
.tokuse-sid { color: #7ab8ff; cursor: pointer; text-decoration: underline dotted; }
.tokuse-sid:hover { color: #b8dcff; }
.tokuse-code { font-weight: 700; font-family: ui-monospace, monospace; }
.tokuse-code.ok { color: #4ade80; }
.tokuse-code.warn { color: #fbbf24; }
.tokuse-code.err { color: #f87171; }
.tokuse-code.pend { color: #94a3b8; }
.tokuse-detail-link { color: #7ab8ff; cursor: pointer; font-size: 11px; }
.tokuse-detail-link:hover { text-decoration: underline; }
.tokuse-detail { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
.tokuse-detail-card { background: var(--tokuse-card, #1c212b); border: 1px solid var(--tokuse-border, #3a4150); border-radius: 12px; padding: 20px 24px; max-width: 640px; width: 92%; max-height: 80vh; overflow: auto; }
.tokuse-detail-card h3 { margin: 0 0 12px; font-size: 15px; }
.tokuse-detail-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid rgba(122,132,152,0.1); }
.tokuse-detail-row .k { color: var(--tokuse-dim, #9aa3b5); min-width: 110px; flex-shrink: 0; }
.tokuse-detail-row .v { word-break: break-all; }
.tokuse-sort-mark { opacity: 0.6; margin-left: 3px; }
`

function Launcher() {
  const open = usePanelOpen()
  return (
    <button className="tokuse-launcher" title="打开 Token 用量统计面板" onClick={() => setPanelOpen(!open)}>
      <span style={{ fontSize: 16 }}>⛃</span>
      <span>Token 用量</span>
    </button>
  )
}

function Detail({ rec, onClose }) {
  const st = statusInfo(rec)
  const rows = [
    ['会话 ID', rec.sessionId],
    ['时间', fmtTime(rec.time)],
    ['提供商', rec.provider],
    ['模型', rec.model],
    ['状态码', st.label + ' (' + st.title + ')'],
    ['错误信息', rec.errorMsg || '—'],
    ['错误码', rec.errorCode || '—'],
    ['Request ID', rec.requestId || '—'],
    ['输入 Token(未缓存)', fmtNum(rec.inputTokens)],
    ['输出 Token', fmtNum(rec.outputTokens)],
    ['缓存命中 Token', fmtNum(rec.cacheReadTokens)],
    ['缓存写入 Token', fmtNum(rec.cacheWriteTokens)],
    ['推理 Token', fmtNum(rec.reasoningTokens)],
    ['计费输入', fmtNum(rec.billedInput)],
    ['缓存命中率', rec.cacheHitPercent + '%'],
    ['总 Token', fmtNum(rec.totalTokens)],
    ['消耗金额(估算)', fmtCost(rec.cost)],
    ['推理强度', rec.effort || '—'],
    ['耗时', fmtDuration(rec.llmMs)],
    ['Turn / Step', rec.turn + ' / ' + rec.step],
  ]
  return (
    <div className="tokuse-detail" onClick={onClose}>
      <div className="tokuse-detail-card" onClick={(e) => e.stopPropagation()}>
        <h3>调用详情</h3>
        {rows.map(([k, v]) => (
          <div className="tokuse-detail-row" key={k}>
            <span className="k">{k}</span>
            <span className="v">{v}</span>
          </div>
        ))}
        <button className="tokuse-btn" style={{ marginTop: 12 }} onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}

function Panel() {
  const open = usePanelOpen()
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [effort, setEffort] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [dim, setDim] = useState('')
  const [sortKey, setSortKey] = useState('time')
  const [sortDir, setSortDir] = useState('desc')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [page, setPage] = useState(0)
  const [detailRec, setDetailRec] = useState(null)
  const pageSize = 100

  useEffect(() => {
    if (!open) return
    let cancel = false
    setLoading(true); setErr('')
    rpcCall('scan', {})
      .then(() => (cancel ? null : rpcCall('query', {})))
      .then((d) => {
        if (cancel) return
        setData(d)
        if (!fromStr && !toStr) {
          const now = Date.now()
          setFromStr(toLocalInput(now - 30 * 86400000))
          setToStr(toLocalInput(now + 86400000))
        }
      })
      .catch((e) => { if (!cancel) setErr(String((e && e.message) || e)) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [open])

  const buildQ = useCallback((withDim) => {
    const q = {}
    if (fromStr) q.from = new Date(fromStr).getTime()
    if (toStr) q.to = new Date(toStr).getTime()
    if (provider) q.provider = provider
    if (model) q.model = model
    if (status) q.status = status
    if (effort) q.effort = effort
    if (sessionId) q.sessionId = sessionId
    if (withDim && dim) q.dim = dim
    return q
  }, [fromStr, toStr, provider, model, status, effort, sessionId, dim])

  const runQuery = useCallback(() => {
    setLoading(true); setErr('')
    rpcCall('query', buildQ(true))
      .then((d) => { setData(d); setPage(0) })
      .catch((e) => setErr(String((e && e.message) || e)))
      .finally(() => setLoading(false))
  }, [buildQ])

  const exportCsv = useCallback(() => {
    rpcCall('export', buildQ(false))
      .then((d) => {
        const blob = new Blob([d.csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'dsh-token-usage-' + Date.now() + '.csv'
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch((e) => setErr(String((e && e.message) || e)))
  }, [buildQ])

  const toggleSort = useCallback((key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }, [sortKey, sortDir])

  if (!open) return null

  const records = (data && data.records) || []
  const totals = data && data.totals
  const sessionIds = (data && data.sessionIds) || []
  const sorted = useMemo(() => {
    const arr = records.slice()
    const key = sortKey
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      const av = a[key]; const bv = b[key]
      if (av === null || av === undefined || av === '') return 1
      if (bv === null || bv === undefined || bv === '') return -1
      if (typeof av === 'string') return av.localeCompare(String(bv)) * dir
      return (Number(av) - Number(bv)) * dir
    })
    return arr
  }, [records, sortKey, sortDir])
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageSafe = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(pageSafe * pageSize, (pageSafe + 1) * pageSize)

  const cards = totals ? [
    { v: fmtNum(totals.calls), l: '调用次数' },
    { v: fmtCompact(totals.totalTokens), l: '总 Token' },
    { v: fmtCompact(totals.inputTokens), l: '输入(未缓存)' },
    { v: fmtCompact(totals.cacheReadTokens), l: '缓存命中' },
    { v: totals.cacheHitPct + '%', l: '缓存命中率' },
    { v: fmtCompact(totals.outputTokens), l: '输出' },
    { v: fmtCost(totals.cost), l: '消耗金额(估算)' },
    { v: fmtDuration(totals.llmMs), l: '累计耗时' + (totals.timed ? ' (' + totals.timed + '步)' : '') },
  ] : []

  const opts = (arr) => (arr || []).map((x) => <option key={x || '(none)'} value={x}>{x || '(空)'}</option>)

  const summaryRows = (data && data.summary || []).map((r) => (
    <tr key={r.key}>
      <td>{r.key}</td><td>{fmtNum(r.calls)}</td><td>{fmtCompact(r.inputTokens)}</td>
      <td>{fmtCompact(r.cacheReadTokens)}</td><td>{r.cacheHitPct + '%'}</td><td>{fmtCompact(r.outputTokens)}</td>
      <td>{fmtCompact(r.totalTokens)}</td><td>{fmtCost(r.cost)}</td><td>{fmtDuration(r.llmMs)}</td>
    </tr>
  ))

  const sortTh = (label, key) => (
    <th onClick={() => toggleSort(key)} title="点击排序">
      {label}{sortKey === key ? <span className="tokuse-sort-mark">{sortDir === 'asc' ? '▲' : '▼'}</span> : null}
    </th>
  )

  const detailRows = pageRows.map((r) => {
    const st = statusInfo(r)
    return (
      <tr key={r.id}>
        <td>{fmtTime(r.time)}</td>
        <td><span className="tokuse-sid" title="点击按此会话筛选" onClick={() => { setSessionId(r.sessionId); runQuery() }}>{shortId(r.sessionId)}</span></td>
        <td>{r.provider || '—'}</td>
        <td>{r.model || '—'}</td>
        <td>{fmtNum(r.inputTokens)}</td>
        <td>{fmtNum(r.cacheReadTokens)}</td>
        <td>{r.cacheHitPercent + '%'}</td>
        <td>{fmtNum(r.outputTokens)}</td>
        <td>{fmtNum(r.reasoningTokens)}</td>
        <td>{fmtNum(r.totalTokens)}</td>
        <td>{fmtCost(r.cost)}</td>
        <td>{r.effort || '—'}</td>
        <td>
          <div><span className={'tokuse-code ' + st.cls}>{st.label}</span></div>
          <div><a className="tokuse-detail-link" onClick={() => setDetailRec(r)}>查看详情</a></div>
        </td>
        <td>{fmtDuration(r.llmMs)}</td>
      </tr>
    )
  })

  const bodyNodes = []
  if (err) bodyNodes.push(<div className="tokuse-empty" style={{ color: '#ff7a7a' }}>错误: {err}</div>)
  if (cards.length) bodyNodes.push(
    <div className="tokuse-cards" key="cards">
      {cards.map((c) => <div className="tokuse-card" key={c.l}><div className="v">{c.v}</div><div className="l">{c.l}</div></div>)}
    </div>
  )
  if (summaryRows.length) bodyNodes.push(
    <div key="sum" className="tokuse-section-title">统计分组: {dim || '无'} ({summaryRows.length} 组)</div>,
    <div key="sumtab" className="tokuse-table-wrap">
      <table className="tokuse-table">
        <thead><tr>
          <th>维度</th><th>调用</th><th>输入</th><th>缓存</th><th>命中率</th><th>输出</th><th>总Token</th><th>金额</th><th>耗时</th>
        </tr></thead>
        <tbody>{summaryRows}</tbody>
      </table>
    </div>
  )
  bodyNodes.push(<div key="dimtitle" className="tokuse-section-title">按维度统计</div>)
  bodyNodes.push(
    <div key="dimrow" className="tokuse-filter" style={{ padding: '4px 0 10px', borderBottom: 0 }}>
      {['', 'provider', 'model', 'status', 'effort'].map((d) => (
        <button key={d} className={'tokuse-btn' + (dim === d ? ' primary' : '')} onClick={() => { setDim(d); runQuery() }}>{d === '' ? '无分组' : d}</button>
      ))}
    </div>
  )
  bodyNodes.push(<div key="dettitle" className="tokuse-section-title">调用明细</div>)
  if (sorted.length === 0) {
    bodyNodes.push(<div key="empty" className="tokuse-empty">{loading ? '加载中…' : '无匹配记录'}</div>)
  } else {
    bodyNodes.push(
      <div key="detail" className="tokuse-table-wrap">
        <table className="tokuse-table">
          <thead><tr>
            {sortTh('时间', 'time')}{sortTh('会话ID', 'sessionId')}{sortTh('提供商', 'provider')}{sortTh('模型', 'model')}
            {sortTh('输入', 'inputTokens')}{sortTh('缓存', 'cacheReadTokens')}{sortTh('命中%', 'cacheHitPercent')}{sortTh('输出', 'outputTokens')}
            {sortTh('推理', 'reasoningTokens')}{sortTh('总额', 'totalTokens')}{sortTh('金额', 'cost')}{sortTh('强度', 'effort')}
            {sortTh('状态', 'status')}{sortTh('耗时', 'llmMs')}
          </tr></thead>
          <tbody>{detailRows}</tbody>
        </table>
      </div>,
      <div key="pager" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 12, color: 'var(--tokuse-dim, #9aa3b5)' }}>
        <button className="tokuse-btn" disabled={pageSafe <= 0} onClick={() => setPage(pageSafe - 1)}>上一页</button>
        <span>第 {pageSafe + 1} / {pageCount} 页</span>
        <button className="tokuse-btn" disabled={pageSafe >= pageCount - 1} onClick={() => setPage(pageSafe + 1)}>下一页</button>
      </div>
    )
  }

  return (
    <div className="tokuse-overlay">
      <div className="tokuse-header">
        <span className="tokuse-title">Token 用量统计</span>
        <span className="tokuse-status">{loading ? '加载中…' : (data ? data.counts.matching + ' / ' + data.counts.total + ' 条' : '')}</span>
        <button className="tokuse-close" onClick={() => setPanelOpen(false)}>✕ 关闭</button>
      </div>
      <div className="tokuse-filter">
        <label>起</label>
        <input className="tokuse-input" type="datetime-local" step="1" value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
        <label>止</label>
        <input className="tokuse-input" type="datetime-local" step="1" value={toStr} onChange={(e) => setToStr(e.target.value)} />
        <label>会话</label>
        <select className="tokuse-select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">全部</option>{opts(sessionIds)}
        </select>
        <label>提供商</label>
        <select className="tokuse-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">全部</option>{opts(data && data.providers)}
        </select>
        <label>模型</label>
        <select className="tokuse-select" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">全部</option>{opts(data && data.models)}
        </select>
        <label>状态</label>
        <select className="tokuse-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>{opts(data && data.statuses)}
        </select>
        <label>推理强度</label>
        <select className="tokuse-select" value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">全部</option>{opts(data && data.efforts)}
        </select>
        <button className="tokuse-btn primary" onClick={runQuery}>查询</button>
        <button className="tokuse-btn" onClick={exportCsv}>导出 CSV</button>
      </div>
      <div className="tokuse-body">{bodyNodes}</div>
      {detailRec ? <Detail rec={detailRec} onClose={() => setDetailRec(null)} /> : null}
    </div>
  )
}

export function apply(ctx) {
  if (typeof styles !== 'undefined' && styles.insert) styles.insert(css)
  // 从 connection 服务初始化 RPC 桥接(静态插件无 host 全局)
  _conn = ctx.get('connection') || null
  ctx.slots.register({ name: 'sidebar.footer.action', id: 'token-usage-launcher', order: 10, label: 'Token 用量' }, Launcher)
  ctx.slots.register({ name: 'shell.overlay', id: 'token-usage-panel', order: 10 }, Panel)
}

export const inject = ['slots', 'connection']
