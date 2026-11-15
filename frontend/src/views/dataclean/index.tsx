import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/dataclean'
const columns = [
  "规则编号",
  "目标字段",
  "HTML标签清理",
  "特殊字符过滤",
  "空白规整模式",
  "长度截断阈值",
  "编码纠错",
  "敏感词脱敏"
]
// 状态机：每个状态只暴露可执行的动作入口，与后端单向推进保持一致
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  "草稿": ["提交规则验证"],
  "规则验证中": ["启用规则"],
  "已启用": ["废弃规则"],
  "已废弃": []
}

type Row = Record<string, string | number | null>
type Fingerprint = {
  指纹编号: string
  引擎编号: string
  字段组版本: number
  指纹状态: string
  退出原因: string
}
type Detail = Row & { 引用指纹?: Fingerprint[] }
type Feedback = { ok: boolean; text: string }

export default function DatacleanView() {
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
        throw new Error('去噪规则列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '数据去噪列表读取失败' })
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  // 工作台统计与列表同一份数据，避免对不上
  const stats = useMemo(() => [
    { label: '去噪规则总数', value: total },
    { label: '已启用规则', value: rows.filter((row) => row.status === '已启用').length },
    { label: '验证中规则', value: rows.filter((row) => row.status === '规则验证中').length },
  ], [rows, total])

  async function runAction(action: string, row: Row) {
    setFeedback(null)
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action } }),
      })
      const payload = await response.json()
      setFeedback({ ok: Boolean(payload.ok), text: String(payload.message ?? '') })
      setDetail(null) // 状态已流转，关掉旧详情避免残留旧值
      await reload()
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '数据去噪操作失败' })
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
        throw new Error('去噪规则详情读取失败')
      }
      setDetail((await response.json()) as Detail)
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : '去噪规则详情读取失败' })
    }
  }

  return (
    <section className="page" data-module="dataclean">
      <header className="page-head">
        <div>
          <h2>数据去噪管理</h2>
          <p className="page-desc">管理采集后数据的去噪清洗规则，包括HTML标签移除、特殊字符过滤和编码纠错。废弃规则会让引用它的去重指纹退出新接入，历史判定保留。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setFeedback({ ok: false, text: '去噪规则登记入口尚未接入审批流' })}>
            登记去噪规则
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出数据去噪清单
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
                  {availableActions.length === 0 && <span className="muted">终态，无可用动作</span>}
                  <button className="link" type="button" onClick={() => void openDetail(row)}>
                    {isOpen ? '收起详情' : '详情'}
                  </button>
                </td>
              </tr>,
              isOpen && (
                <tr key={`${String(row.id)}-detail`}>
                  <td colSpan={columns.length + 2}>
                    <div className="detail-panel">
                      <p>规则编号：{String(detail.规则编号 ?? '—')} ｜ 状态：{String(detail.status ?? '—')}</p>
                      <p>引用本规则的去重指纹（共 {detail.引用指纹?.length ?? 0} 条）：</p>
                      {detail.引用指纹 && detail.引用指纹.length > 0 ? (
                        <ul>
                          {detail.引用指纹.map((fp) => (
                            <li key={fp.指纹编号}>
                              {fp.指纹编号}（引擎 {fp.引擎编号}，v{fp.字段组版本}）：{fp.指纹状态}
                              {fp.退出原因 ? ` ｜ ${fp.退出原因}` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">暂无去重指纹引用该规则</p>
                      )}
                    </div>
                  </td>
                </tr>
              ),
            ]
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无数据去噪数据，可先登记去噪规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据去噪记录</span>
        {feedback && <span className={feedback.ok ? 'ok-text' : 'error-text'}>{feedback.text}</span>}
      </footer>
    </section>
  )
}
