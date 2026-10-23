/**
 * The DAG canvas: renders a workflow through xyflow with workflow nodes and
 * route-colored edges, live run status, and validation markers. Editing
 * intents go out through callbacks; the canvas owns only in-flight drag
 * positions.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type { EdgeRoute, LintIssue, NodeType, Workflow, WorkflowRun } from '../api/types.ts'
import type { Selection } from '../store/flow.ts'
import { BRAND } from '../brand.ts'
import type { Translate } from '../i18n/translate.ts'
import { tx } from '../i18n/translate.ts'
import { edgeTypes, nodeTypes, type FlowCanvasEdge, type FlowCanvasNode } from './nodes.tsx'

/** Small graphs fit on screen; a minimap only adds an empty box there. */
const MINIMAP_MIN_NODES = 12

/** Free area for fitting: clear of the toolbar (top) and the node palette (left), which float over the canvas. */
const FIT_PAD = { top: 84, left: 244, right: 48, bottom: 48 }
/**
 * Never fit below a zoom where node text stays readable. A graph wider than
 * the view at that zoom starts at its first step (left) instead of being
 * shrunk to an unreadable overview; pan or zoom out to see the rest.
 */
export const READABLE_ZOOM = 0.75
const FIT_VIEW = { padding: { top: `${FIT_PAD.top}px`, left: `${FIT_PAD.left}px`, right: `${FIT_PAD.right}px`, bottom: `${FIT_PAD.bottom}px` }, maxZoom: 1, minZoom: READABLE_ZOOM } as const

/** Viewport that fits `bounds` into a `width` x `height` box at a readable zoom (left-aligned when it cannot fit). */
export function readableViewport(bounds: { x: number; y: number; width: number; height: number }, width: number, height: number): { x: number; y: number; zoom: number } {
  const freeW = Math.max(1, width - FIT_PAD.left - FIT_PAD.right)
  const freeH = Math.max(1, height - FIT_PAD.top - FIT_PAD.bottom)
  const zoom = Math.min(1, Math.max(READABLE_ZOOM, Math.min(freeW / Math.max(1, bounds.width), freeH / Math.max(1, bounds.height))))
  const x = bounds.width * zoom <= freeW ? FIT_PAD.left + (freeW - bounds.width * zoom) / 2 - bounds.x * zoom : FIT_PAD.left - bounds.x * zoom
  const y = bounds.height * zoom <= freeH ? FIT_PAD.top + (freeH - bounds.height * zoom) / 2 - bounds.y * zoom : FIT_PAD.top - bounds.y * zoom
  return { x, y, zoom }
}

export const DRAG_MIME = `application/x-${BRAND.id}-node`

export interface CanvasProps {
  workflow: Workflow
  issues: readonly (LintIssue & { code?: string })[]
  selection: Selection
  run?: WorkflowRun | null
  readOnly?: boolean
  t: Translate
  onMoveNode?: (id: string, position: { x: number; y: number }) => void
  onConnect?: (source: string, target: string, route?: EdgeRoute) => void
  onSelect?: (selection: Selection) => void
  onDelete?: (selection: { nodes: string[]; edges: string[] }) => void
  onDropNode?: (type: NodeType, position: { x: number; y: number }) => void
  onReady?: (api: { centre: () => { x: number; y: number } }) => void
}

const TYPE_TINT: Record<string, string> = { input: '#0ea5a4', output: '#0f9d6b', agent: '#3b6cf6', kernel: '#7c4dff', script: '#c2410c', http: '#0284c7', condition: '#c026d3', loop: '#4f46e5', approval: '#b45309', notify: '#db2777' }
const minimapColor = (node: FlowCanvasNode): string => TYPE_TINT[node.data.node.type] ?? '#888'

export function issueText(t: Translate, issue: LintIssue & { code?: string }): string {
  return issue.code ? tx(t, issue.code, issue.message) : issue.message
}

export function Canvas(props: CanvasProps): ReactElement {
  const { workflow, issues, selection, run, readOnly = false, t } = props
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({})
  // Controlled xyflow nodes must carry their measured size back in, or fitView and the minimap see zero-size nodes.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})
  const wrapper = useRef<HTMLDivElement | null>(null)
  const flow = useRef<ReactFlowInstance<FlowCanvasNode, FlowCanvasEdge> | null>(null)
  const fitted = useRef(false)

  const nodes = useMemo<FlowCanvasNode[]>(
    () =>
      workflow.nodes.map(node => {
        const own = issues.filter(i => i.nodeId === node.id)
        const evidence = run?.nodes[node.id]
        const attempts = evidence?.attempts.length ?? 0
        return {
          id: node.id,
          type: 'flow',
          position: drag[node.id] ?? node.position,
          ...(measured[node.id] ? { measured: measured[node.id] } : {}),
          selected: selection?.kind === 'node' && selection.id === node.id,
          draggable: !readOnly,
          connectable: !readOnly,
          deletable: !readOnly,
          ariaLabel: node.name,
          data: {
            node,
            t,
            ...(evidence ? { status: evidence.status } : run ? { status: 'pending' as const } : {}),
            issues: own.length,
            issueText: own.map(i => issueText(t, i)).join('\n'),
            readOnly,
            ...(attempts > 1 ? { progress: t('run.attempt', { count: attempts }) } : {}),
          },
        }
      }),
    [workflow.nodes, issues, run, drag, measured, selection, readOnly, t],
  )

  const edges = useMemo<FlowCanvasEdge[]>(
    () =>
      workflow.edges.map(edge => {
        const source = workflow.nodes.find(n => n.id === edge.source)
        const route: EdgeRoute = edge.route ?? (source?.type === 'condition' ? 'true' : 'success')
        const taken = run ? run.nodes[edge.source]?.route === route : undefined
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: route,
          type: 'route',
          selected: selection?.kind === 'edge' && selection.id === edge.id,
          deletable: !readOnly,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          ariaLabel: t('canvas.edgeAria', { source: source?.name ?? edge.source, target: workflow.nodes.find(n => n.id === edge.target)?.name ?? edge.target, route: t(`route.${route}` as never) }),
          data: { route, label: t(`route.short.${route}` as never), invalid: issues.some(i => i.edgeId === edge.id), ...(taken !== undefined ? { taken } : {}) },
        }
      }),
    [workflow.edges, workflow.nodes, issues, run, selection, readOnly, t],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowCanvasNode>[]) => {
      const removed: string[] = []
      const sizes = changes.filter(c => c.type === 'dimensions' && c.dimensions) as Array<{ id: string; dimensions: { width: number; height: number } }>
      if (sizes.length > 0) {
        setMeasured(m => ({ ...m, ...Object.fromEntries(sizes.map(c => [c.id, c.dimensions])) }))
        // Fit once every node has a real size (the initial fitView runs before measurement).
        if (!fitted.current) {
          fitted.current = true
          requestAnimationFrame(() => {
            const instance = flow.current
            const box = wrapper.current?.getBoundingClientRect()
            if (!instance) return
            if (!box || box.width === 0) {
              void instance.fitView(FIT_VIEW)
              return
            }
            void instance.setViewport(readableViewport(instance.getNodesBounds(instance.getNodes()), box.width, box.height))
          })
        }
      }
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (change.dragging) setDrag(d => ({ ...d, [change.id]: change.position! }))
          else {
            props.onMoveNode?.(change.id, change.position)
            setDrag(d => {
              const { [change.id]: _, ...rest } = d
              return rest
            })
          }
        } else if (change.type === 'position' && change.dragging === false) {
          const pos = drag[change.id]
          if (pos) props.onMoveNode?.(change.id, pos)
          setDrag(d => {
            const { [change.id]: _, ...rest } = d
            return rest
          })
        } else if (change.type === 'remove') removed.push(change.id)
        else if (change.type === 'select' && change.selected) props.onSelect?.({ kind: 'node', id: change.id })
      }
      if (removed.length > 0 && !readOnly) props.onDelete?.({ nodes: removed, edges: [] })
    },
    [props, drag, readOnly],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowCanvasEdge>[]) => {
      const removed = changes.filter(c => c.type === 'remove').map(c => c.id)
      for (const change of changes) if (change.type === 'select' && change.selected) props.onSelect?.({ kind: 'edge', id: change.id })
      if (removed.length > 0 && !readOnly) props.onDelete?.({ nodes: [], edges: removed })
    },
    [props, readOnly],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) return
      props.onConnect?.(connection.source, connection.target, (connection.sourceHandle ?? undefined) as EdgeRoute | undefined)
    },
    [props, readOnly],
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const type = event.dataTransfer.getData(DRAG_MIME) as NodeType
      if (!type || readOnly || flow.current === null) return
      event.preventDefault()
      props.onDropNode?.(type, flow.current.screenToFlowPosition({ x: event.clientX - 110, y: event.clientY - 30 }))
    },
    [props, readOnly],
  )

  const aria = useMemo(
    () => ({
      'node.a11yDescription.default': t('canvas.a11y.node'),
      'node.a11yDescription.keyboardDisabled': t('canvas.a11y.nodeKeyboardDisabled'),
      'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => t('canvas.a11y.moved', { direction, x, y }),
      'edge.a11yDescription.default': t('canvas.a11y.edge'),
      'controls.ariaLabel': t('canvas.controls'),
      'controls.zoomIn.ariaLabel': t('canvas.zoomIn'),
      'controls.zoomOut.ariaLabel': t('canvas.zoomOut'),
      'controls.fitView.ariaLabel': t('canvas.fitView'),
      'controls.interactive.ariaLabel': t('canvas.lock'),
      'minimap.ariaLabel': t('canvas.minimap'),
      'handle.ariaLabel': t('canvas.handle'),
    }),
    [t],
  )

  return (
    <div
      ref={wrapper}
      className="lxf-canvas"
      role="application"
      aria-label={t('canvas.aria', { name: workflow.name })}
      onDragOver={event => {
        if (!readOnly && event.dataTransfer.types.includes(DRAG_MIME)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
    >
      <ReactFlow<FlowCanvasNode, FlowCanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => props.onSelect?.(null)}
        onInit={instance => {
          flow.current = instance
          props.onReady?.({
            centre: () => {
              const box = wrapper.current?.getBoundingClientRect()
              return instance.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2 - 110, y: (box?.top ?? 0) + (box?.height ?? 400) / 2 - 30 })
            },
          })
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        nodesFocusable
        edgesFocusable
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={aria}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} className="lxf-canvas__bg" />
        <Controls className="lxf-canvas__controls" showInteractive={false} fitViewOptions={FIT_VIEW} />
        {nodes.length > MINIMAP_MIN_NODES && <MiniMap className="lxf-canvas__minimap" pannable zoomable nodeStrokeWidth={0} nodeBorderRadius={10} nodeColor={minimapColor} style={{ width: 168, height: 108 }} />}
      </ReactFlow>
    </div>
  )
}

/** Re-export for consumers that need the instance hook inside a provider. */
export { useReactFlow }
