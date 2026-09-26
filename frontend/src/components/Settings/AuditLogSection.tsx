import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AuditActionName, type AuditEntry } from '../../api/client'
import { SectionTitle } from './toggleRow'

/* ── 安全审计日志（只读） ───────────────────────────────────────────
 *
 * 展示后端 `GET /settings/audit-log` 返回的最近敏感操作留痕：文件写/删/上传、
 * git push、agent 配置变更、代理端口首次被访问。**只读**——入口没有写侧，
 * 清理由后端 `audit_log` 表的滚动删除负责（MAX_AUDIT_ROWS）。
 */

/** 一次拉取的条数。后端硬顶 200，这里取 60：桌面设置弹窗仅 33vh 高，
 *  再多也看不到，且响应体越小越好。 */
const PAGE_SIZE = 60

/** 动作 → i18n key 后缀（`settings.auditLog.action.<key>`）。
 *   Protocols 稳定值，后端加动作时这里同步补一行。 */
const ACTION_KEYS: Record<AuditActionName, string> = {
  file_write: 'fileWrite',
  file_delete: 'fileDelete',
  file_upload: 'fileUpload',
  git_push: 'gitPush',
  agent_create: 'agentCreate',
  agent_update: 'agentUpdate',
  agent_delete: 'agentDelete',
  proxy_access: 'proxyAccess',
}

export function AuditLogSection() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)

  useEffect(() => {
    let alive = true
    // 失败静默：读不到审计不阻塞设置面板其余部分（request() 已会弹错误 toast）。
    api
      .getAuditLog(PAGE_SIZE)
      .then((res) => {
        if (alive) setEntries(res.entries)
      })
      .catch(() => {
        if (alive) setEntries([])
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.auditLog')}</SectionTitle>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {t('settings.auditLogHint')}
      </p>
      {entries === null ? null : entries.length === 0 ? (
        <div className="audit-empty">{t('settings.auditLogEmpty')}</div>
      ) : (
        <div className="audit-list">
          {entries.map((e) => (
            <div key={e.id} className="audit-row">
              <div className="audit-action">
                {/* 动作名走 i18n；未知动作（后端比前端新）回落原始串，
                    不渲染 "undefined" 也不静默丢行。 */}
                {t(`settings.auditLog.action.${ACTION_KEYS[e.action] ?? e.action}`)}
              </div>
              <div className="audit-target" title={e.target}>
                {e.target || '—'}
              </div>
              <div className="audit-meta">
                <span>{e.actor}</span>
                {e.scope && <span title={e.scope}>{e.scope}</span>}
                <span>{formatTime(e.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** RFC3339 → 本地短时间（同一天只显示时刻，跨天附日期）。
 *  解析失败时回落原始串——宁可显示原值也不要显示 "Invalid Date"。 */
function formatTime(rfc3339: string): string {
  const d = new Date(rfc3339)
  if (Number.isNaN(d.getTime())) return rfc3339
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`
}
