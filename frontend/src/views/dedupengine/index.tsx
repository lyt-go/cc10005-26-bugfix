import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/dedupengine'
const columns = [
  "引擎编号",
  "去重字段组",
  "哈希算法",
  "布隆过滤器大小",
  "误判容忍率",
  "滑动窗口天",
  "跨批次去重",
  "相似度阈值",
  "绑定清洗规则",
  "字段组版本"
]
// 状态机：每个状态只暴露可执行的动作入口，与后端单向推进保持一致
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  "草稿": ["提交引擎评估"],
  "引擎评估中": ["启用引擎"],
  "已启用": ["停用引擎"],
  "已停用": ["提交引擎评估"]
}

type Row = Record<string, string | number | null>
type Fingerprint = {
  指纹编号: string
  字段组版本: number
  绑定规则编号: string
  滑动窗口天: string
  指纹状态: string
  创建时间: string
  退出时间: string
  退出原因: string
}
type Detail = Row & { 指纹列表?: Fingerprint[] }
type Feedback = { ok: boolean; text: string }

export default function DedupengineView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<Detail | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(async () => {
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('去重引擎列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '采集去重列表读取失败' })
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  // 工作台统计与列表同一份数据，避免对不上
  const stats = useMemo(() => [
    { label: '去重引擎总数', value: total },
    { label: '已启用引擎', value: rows.filter((row) => row.status === '已启用').length },
    { label: '评估中引擎', value: rows.filter((row) => row.status === '引擎评估中').length },
  ], [rows, total])

  async function runAction(action: string, row: Row, extraValues: Record<string, string | number> = {}) {
    setFeedback(null)
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action, ...extraValues } }),
      })
      const payload = await response.json()
      // 重新启用必须建立新字段组版本：后端回 need_version 时补录版本号后重试
      if (!payload.ok && payload.extra?.need_version) {
        const input = window.prompt(`${payload.message}\n请输入新的字段组版本号（当前 v${payload.extra.current_version}）：`)
        if (input !== null && input.trim() !== '') {
          return await runAction(action, row, { ...extraValues, 字段组版本: input.trim() })
        }
        setFeedback({ ok: false, text: '已取消启用：未提供新字段组版本' })
        return
      }
      setFeedback({ ok: Boolean(payload.ok), text: String(payload.message ?? '') })
      setDetail(null) // 状态已流转，关掉旧详情避免残留旧值
      await reload()
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '采集去重操作失败' })
    }
  }

  async function openDetail(row: Row) {
    setFeedback(null)
    if (detail && detail.id === row.id) {
      setDetail(null)
      return
    }
    try {
      const response = await request(`${ENDPOINT}/${row.id}`)
      if (!response.ok) {
        throw new Error('去重引擎详情读取失败')
      }
      setDetail((await response.json()) as Detail)
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '去重引擎详情读取失败' })
    }
  }

  return (
    <section className="page" data-module="dedupengine">
      <header className="page-head">
        <div>
          <h2>采集去重管理</h2>
          <p className="page-desc">管理采集数据的去重引擎配置。引擎按 评估→启用→停用 单向推进，重新启用必须建立新字段组版本，旧指纹退出后不再用于新接入判定。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setFeedback({ ok: false, text: '去重引擎登记入口尚未接入审批流' })}>
            登记去重引擎
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出采集去重清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = String(row.status ?? '')
            const availableActions = ACTIONS_BY_STATUS[status] ?? []
            const isOpen = detail !== null && detail.id === row.id
            return [
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{status || '—'}</td>
                <td className="row-actions">
                  {availableActions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                  <button className="link" type="button" onClick={() => void openDetail(row)}>
                    {isOpen ? '收起详情' : '详情'}
                  </button>
                </td>
              </tr>,
              isOpen && (
                <tr key={`${String(row.id)}-detail`}>
                  <td colSpan={columns.length + 2}>
                    <div className="detail-panel">
                      <p>
                        引擎编号：{String(detail.引擎编号 ?? '—')} ｜ 状态：{String(detail.status ?? '—')} ｜
                        当前字段组版本：v{String(detail.字段组版本 ?? '—')} ｜ 绑定清洗规则：{String(detail.绑定清洗规则 ?? '—')}
                      </p>
                      <p>指纹履历（共 {detail.指纹列表?.length ?? 0} 条，历史判定保留）：</p>
                      {detail.指纹列表 && detail.指纹列表.length > 0 ? (
                        <ul>
                          {detail.指纹列表.map((fp) => (
                            <li key={fp.指纹编号}>
                              {fp.指纹编号}（绑定 {fp.绑定规则编号}，滑动窗口 {fp.滑动窗口天}）：{fp.指纹状态}
                              {fp.退出原因 ? ` ｜ ${fp.退出原因}（${fp.退出时间}）` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">尚未登记指纹，启用引擎后生成</p>
                      )}
                    </div>
                  </td>
                </tr>
              ),
            ]
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无采集去重数据，可先登记去重引擎</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条采集去重记录</span>
        {feedback && <span className={feedback.ok ? 'ok-text' : 'error-text'}>{feedback.text}</span>}
      </footer>
    </section>
  )
}
