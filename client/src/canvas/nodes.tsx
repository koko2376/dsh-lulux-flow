/** Custom xyflow node and edge renderers for workflows. */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type EdgeProps, type NodeProps, type Node, type Edge } from '@xyflow/react'
import { memo, type ReactElement } from 'react'
import { routesFor, type EdgeRoute, type NodeStatus, type WorkflowNode } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { avatarFor } from '../ui/avatars.ts'
import { cx } from '../ui/glass.tsx'
import { NodeIcons, IconWarning } from '../ui/icons.tsx'

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode
  t: Translate
  status?: NodeStatus
  issues: number
  issueText?: string
  readOnly: boolean
  progress?: string
}

export type FlowCanvasNode = Node<FlowNodeData, 'flow'>

export interface RouteEdgeData extends Record<string, unknown> {
  route: EdgeRoute
  label: string
  invalid: boolean
  taken?: boolean
}

export type FlowCanvasEdge = Edge<RouteEdgeData, 'route'>

const ROUTE_POS: Record<string, string> = { success: '34%', failure: '72%', true: '34%', false: '72%' }

function subtitle(node: WorkflowNode, t: Translate): string {
  const c = node.config
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (node.type) {
    case 'kernel':
      return s(c.kernel)
    case 'http':
      return `${s(c.method) || 'GET'} ${s(c.url)}`.trim()
    case 'notify':
      return `${s(c.format) || 'json'} · ${s(c.url)}`
    case 'condition':
      return s(c.expression)
    case 'loop':
      return `${s(c.mode) || 'items'} · ≤${String(c.maxIterations ?? 10)}`
    case 'agent':
    case 'approval':
      return s(c.prompt ?? c.message)
    case 'script':
      return t('node.script.subtitle')
    default:
      return ''
  }
}

export const FlowNode = memo(function FlowNode({ data, selected }: NodeProps<FlowCanvasNode>): ReactElement {
  const { node, t, status, issues, issueText } = data
  const Icon = NodeIcons[node.type]
  const routes = routesFor(node.type)
  const sub = subtitle(node, t)
  // A step that is not configured yet says in plain words what it is for.
  const hint = sub ? '' : t(`node.desc.${node.type}` as never)
  const typeLabel = t(`node.type.${node.type}` as never)
  const statusLabel = status ? t(`status.${status}` as never) : undefined
  return (
    <div
      className={cx('lxf-node', `lxf-node--${node.type}`, selected && 'is-selected', status && `is-${status}`, issues > 0 && 'has-issues')}
      data-status={status}
      aria-label={`${t(`node.type.${node.type}` as never)}: ${node.name}${statusLabel ? ` · ${statusLabel}` : ''}${issues > 0 ? ` · ${t('canvas.issueCount', { count: issues })}` : ''}`}
    >
      {node.type !== 'input' && <Handle type="target" position={Position.Left} className="lxf-handle lxf-handle--in" aria-label={t('canvas.handleIn')} />}
      <div className="lxf-node__head">
        <span className="lxf-node__icon">
          {node.type === 'kernel' ? <img src={avatarFor(String(node.config.kernel ?? ''))} alt="" width={22} height={22} /> : <Icon size={16} />}
        </span>
        <span className="lxf-node__titles">
          <span className="lxf-node__name">{node.name || node.id}</span>
          {(node.name || node.id) !== typeLabel && <span className="lxf-node__type">{typeLabel}</span>}
        </span>
        {status && <span className={cx('lxf-node__status', `is-${status}`)} title={statusLabel} aria-hidden="true" />}
      </div>
      {sub && <div className="lxf-node__sub">{sub}</div>}
      {hint && <div className="lxf-node__hint">{hint}</div>}
      {(node.retry?.max ?? 0) > 0 || node.timeoutMs || node.continueOnFailure ? (
        <div className="lxf-node__chips">
          {(node.retry?.max ?? 0) > 0 && <span className="lxf-chip">{t('node.chip.retry', { count: node.retry!.max })}</span>}
          {node.timeoutMs ? <span className="lxf-chip">{t('node.chip.timeout', { seconds: Math.round(node.timeoutMs / 1000) })}</span> : null}
          {node.continueOnFailure && <span className="lxf-chip">{t('node.chip.continue')}</span>}
        </div>
      ) : null}
      {data.progress && <div className="lxf-node__progress">{data.progress}</div>}
      {issues > 0 && (
        <span className="lxf-node__issue" title={issueText}>
          <IconWarning size={12} />
          {issues}
        </span>
      )}
      {routes.map(route => (
        <Handle
          key={route}
          id={route}
          type="source"
          position={Position.Right}
          className={cx('lxf-handle', `lxf-handle--${route}`)}
          style={{ top: routes.length === 1 ? '50%' : ROUTE_POS[route] }}
          aria-label={t(`route.${route}` as never)}
        >
          <span className="lxf-handle__tag">{t(`route.short.${route}` as never)}</span>
        </Handle>
      ))}
    </div>
  )
})

export const RouteEdge = memo(function RouteEdge(props: EdgeProps<FlowCanvasEdge>): ReactElement {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const route = data?.route ?? 'success'
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} className={cx('lxf-edge', `lxf-edge--${route}`, selected && 'is-selected', data?.invalid && 'is-invalid', data?.taken && 'is-taken')} />
      <EdgeLabelRenderer>
        {(route !== 'success' || data?.invalid || selected) && (
          <div className={cx('lxf-edge__label', `lxf-edge--${route}`, data?.invalid && 'is-invalid', selected && 'is-selected')} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data?.label}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
})

export const nodeTypes = { flow: FlowNode }
export const edgeTypes = { route: RouteEdge }
