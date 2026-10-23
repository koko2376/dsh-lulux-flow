/** Workflows view: list, floating toolbar, palette, canvas and inspector/run panel. */
import { ReactFlowProvider } from '@xyflow/react'
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { NodeType, ReviewInfo } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { isDirty, needsReview, ACTIVE_RUN, type FlowActions, type FlowState } from '../store/flow.ts'
import { localLint, mergeIssues } from '../store/graph.ts'
import type { SelectorHook } from '../store/store.ts'
import { RunHistory } from '../runs/RunHistory.tsx'
import { RunInspector } from '../runs/RunInspector.tsx'
import { Badge, Button, Empty, IconButton, Popover, Segmented, Spinner, cx } from '../ui/glass.tsx'
import { BRAND_AVATAR } from '../ui/avatars.ts'
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconClock, IconShield, IconDownload, IconHistory, IconLayout, IconPlay, IconPlus, IconSave, IconSearch, IconSparkles, IconTrash, IconSidebar, IconSidebarRight, IconUpload, IconWarning } from '../ui/icons.tsx'
import { Canvas, issueText } from './Canvas.tsx'
import { EdgeInspector } from './EdgeInspector.tsx'
import { GenerateDialog, ImportDialog, RunDialog, TriggersDialog } from './dialogs.tsx'
import { Inspector } from './Inspector.tsx'
import { usePanelLayout, type PanelSide } from './layout.ts'
import { PanelResizer } from './PanelResizer.tsx'
import { Palette } from './Palette.tsx'
import { WorkflowSettings } from './WorkflowSettings.tsx'

type PanelTab = 'inspect' | 'run' | 'history'

export interface WorkflowsViewProps {
  t: Translate
  locale: string
  useFlow: SelectorHook<FlowState>
  actions: FlowActions
}

export function WorkflowsView({ t, locale, useFlow, actions }: WorkflowsViewProps): ReactElement {
  const list = useFlow(s => s.workflows)
  const editor = useFlow(s => s.editor)
  const dirty = useFlow(isDirty)
  const meta = useFlow(s => s.meta)
  const kernels = useFlow(s => s.kernels.items)
  const runs = useFlow(s => s.runs)
  const unreviewed = useFlow(needsReview)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<null | 'generate' | 'import' | 'run' | 'triggers'>(null)
  const [tab, setTab] = useState<PanelTab>('inspect')
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreBtn = useRef<HTMLButtonElement | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const sidebarEl = useRef<HTMLElement | null>(null)
  const panelEl = useRef<HTMLElement | null>(null)
  const panelOf = useCallback((side: PanelSide) => (side === 'left' ? sidebarEl.current : panelEl.current), [])
  const panels = usePanelLayout(root, panelOf)
  const [resizing, setResizing] = useState(false)
  // Something changed in the inspector while it was collapsed.
  const [panelHint, setPanelHint] = useState(false)
  const issuesBtn = useRef<HTMLButtonElement | null>(null)
  const centre = useRef<() => { x: number; y: number }>(() => ({ x: 200, y: 200 }))
  const wf = editor.workflow
  const { leftOpen, rightOpen } = panels.layout
  // Without an open workflow the list is the only way in, so it stays visible.
  const listHidden = !leftOpen && wf !== null
  const panelHidden = !rightOpen
  const scriptsAllowed = meta?.scriptsAllowed ?? false

  const issues = useMemo(() => (wf ? mergeIssues(editor.issues, localLint(wf, { scriptsAllowed })) : []), [wf, editor.issues, scriptsAllowed])
  const errors = issues.filter(i => i.level === 'error').length
  const warnings = issues.length - errors
  const filtered = list.items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
  const wfRuns = wf ? runs.items.filter(r => r.workflowId === wf.id) : []
  const activeRun = wf && runs.active?.workflowId === wf.id ? runs.active : null
  const showRun = tab === 'run' && activeRun !== null
  const selectedNode = wf && editor.selection?.kind === 'node' ? wf.nodes.find(n => n.id === editor.selection!.id) : undefined
  const selectedEdge = wf && editor.selection?.kind === 'edge' ? wf.edges.find(e => e.id === editor.selection!.id) : undefined

  const togglePanel = (): void => {
    if (!rightOpen) setPanelHint(false)
    panels.toggle('right')
  }
  const openPanel = (): void => {
    setPanelHint(false)
    panels.setOpen('right', true)
  }
  /** Shows a tab: opens the panel when asked for explicitly, otherwise only marks the toggle. */
  const showTab = (next: PanelTab, open = false): void => {
    setTab(next)
    if (rightOpen) return
    if (open) openPanel()
    else setPanelHint(true)
  }
  const layoutStyle = {
    ...(panels.widths.left !== null && { '--lxf-left-w': `${panels.widths.left}px` }),
    ...(panels.widths.right !== null && { '--lxf-right-w': `${panels.widths.right}px` }),
  } as CSSProperties
  const resizer = (side: PanelSide) => (
    <PanelResizer
      side={side}
      label={t(side === 'left' ? 'layout.resizeList' : 'layout.resizePanel')}
      title={t('layout.resize')}
      value={panels.widths[side] ?? panels.widthOf(side)}
      bounds={() => panels.boundsOf(side)}
      current={() => panels.widthOf(side)}
      onPreview={width => root.current?.style.setProperty(side === 'left' ? '--lxf-left-w' : '--lxf-right-w', `${width}px`)}
      onCommit={width => panels.setWidth(side, width)}
      onDragChange={setResizing}
    />
  )

  const canRun = errors === 0 && !unreviewed
  const runTitle = unreviewed ? t('review.approveFirst') : errors > 0 ? t('toolbar.fixFirst') : undefined
  const startRun = (): void => ((wf?.inputs?.length ?? 0) > 0 ? setDialog('run') : void actions.run({}).then(() => showTab('run')))

  const create = (): void => void actions.newWorkflow(t('workflows.untitled'), { input: t('node.type.input'), output: t('node.type.output') })

  const addNode = (type: NodeType, position?: { x: number; y: number }): void => {
    actions.addNode(type, position ?? centre.current(), t(`node.type.${type}` as never))
    showTab('inspect')
  }

  const download = async (): Promise<void> => {
    const out = await actions.exportJson()
    if (!out) return
    const url = URL.createObjectURL(new Blob([out.json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = out.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div ref={root} className={cx('lxf-workflows', listHidden && 'is-list-hidden', wf && panelHidden && 'is-panel-hidden', resizing && 'is-resizing')} style={layoutStyle}>
      <aside ref={sidebarEl} id="lxf-workflow-list" className="lxf-glass lxf-sidebar" aria-label={t('workflows.list')} hidden={listHidden}>
        <div className="lxf-sidebar__head">
          <h2 className="lxf-sidebar__title">{t('workflows.title')}</h2>
          <span className="lxf-sidebar__actions">
            <IconButton label={t('workflows.new')} icon={<IconPlus />} variant="glass" onClick={create} />
            {wf && <IconButton className="lxf-collapse" label={t('toolbar.hideList')} icon={<IconChevronLeft size={14} />} aria-controls="lxf-workflow-list" aria-expanded onClick={() => panels.setOpen('left', false)} />}
          </span>
        </div>
        <label className="lxf-search">
          <IconSearch size={14} />
          <input type="search" className="lxf-search__input" placeholder={t('workflows.search')} aria-label={t('workflows.search')} value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <div className="lxf-sidebar__list">
          {list.status === 'loading' && <div className="lxf-center"><Spinner label={t('common.loading')} /></div>}
          {list.status === 'error' && (
            <div className="lxf-callout is-error">
              {t('workflows.loadError')} <button type="button" className="lxf-link" onClick={() => void actions.refreshWorkflows()}>{t('common.retry')}</button>
            </div>
          )}
          {list.status === 'ready' && filtered.length === 0 && <p className="lxf-muted lxf-pad">{query ? t('workflows.noMatch') : t('workflows.none')}</p>}
          <ul className="lxf-wflist">
            {filtered.map(item => (
              <li key={item.id} className={cx('lxf-wflist__item', wf?.id === item.id && 'is-active')}>
                <button type="button" className="lxf-wflist__open" aria-current={wf?.id === item.id ? 'page' : undefined} onClick={() => void actions.openWorkflow(item.id)}>
                  <span className="lxf-wflist__name">{item.name}</span>
                  <span className="lxf-wflist__meta">
                    {item.lastRun && <span className={cx('lxf-dot', `is-${item.lastRun.status}`)} aria-hidden="true" />}
                    {t('workflows.nodes', { count: item.nodes })}
                    {item.lastRun ? ` · ${t(`status.${item.lastRun.status}` as never)}` : ''}
                    {item.review?.status === 'unreviewed' && (
                      <Badge tone="warn" title={t('workflows.unreviewedHint')}>
                        {t('workflows.unreviewed')}
                      </Badge>
                    )}
                  </span>
                </button>
                {confirmDelete === item.id ? (
                  <span className="lxf-wflist__confirm">
                    <Button size="sm" variant="danger" onClick={() => void actions.deleteWorkflow(item.id).then(() => setConfirmDelete(null))}>
                      {t('common.delete')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                      {t('common.cancel')}
                    </Button>
                  </span>
                ) : (
                  <IconButton className="lxf-wflist__del" label={t('workflows.delete', { name: item.name })} icon={<IconTrash size={14} />} onClick={() => setConfirmDelete(item.id)} />
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="lxf-sidebar__foot">
          <Button size="sm" icon={<IconSparkles />} onClick={() => setDialog('generate')}>
            {t('workflows.generate')}
          </Button>
          <Button size="sm" variant="ghost" icon={<IconUpload />} onClick={() => setDialog('import')}>
            {t('workflows.import')}
          </Button>
        </div>
      </aside>

      {!listHidden && resizer('left')}

      <section className="lxf-stage" aria-label={t('canvas.region')}>
        {editor.loading && <div className="lxf-center lxf-stage__loading"><Spinner label={t('common.loading')} /></div>}
        {!wf && !editor.loading && (
          <Empty
            art={<img src={BRAND_AVATAR} alt="" width={72} height={72} className="lxf-empty__art" />}
            title={t('canvas.emptyTitle')}
            detail={t('canvas.emptyDetail')}
            action={
              <div className="lxf-empty__start">
                <ol className="lxf-steps">
                  {(['canvas.step1', 'canvas.step2', 'canvas.step3'] as const).map((key, i) => (
                    <li key={key} className="lxf-steps__item">
                      <span className="lxf-steps__num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span>{t(key)}</span>
                    </li>
                  ))}
                </ol>
                <div className="lxf-row">
                  <Button variant="primary" icon={<IconPlus />} onClick={create}>
                    {t('workflows.new')}
                  </Button>
                  <Button icon={<IconSparkles />} onClick={() => setDialog('generate')}>
                    {t('workflows.generate')}
                  </Button>
                </div>
              </div>
            }
          />
        )}
        {wf && (
          <ReactFlowProvider>
            <div className="lxf-toolbar" role="toolbar" aria-label={t('toolbar.aria')}>
              <IconButton label={leftOpen ? t('toolbar.hideList') : t('toolbar.showList')} icon={<IconSidebar />} aria-controls="lxf-workflow-list" aria-expanded={leftOpen} onClick={() => panels.toggle('left')} />
              <input className="lxf-toolbar__name" size={Math.min(Math.max(wf.name.length, 6), 28)} aria-label={t('workflow.name')} maxLength={120} value={wf.name} onChange={e => actions.updateWorkflow(w => ({ ...w, name: e.target.value }))} />
              {dirty && <span className="lxf-toolbar__dirty" title={t('toolbar.unsaved')} aria-label={t('toolbar.unsaved')} />}
              <span className="lxf-toolbar__sep" aria-hidden="true" />
              <button
                ref={issuesBtn}
                type="button"
                className={cx('lxf-toolbar__issues', errors > 0 ? 'is-error' : warnings > 0 ? 'is-warn' : 'is-ok')}
                aria-expanded={issuesOpen}
                aria-haspopup="dialog"
                onClick={() => setIssuesOpen(o => !o)}
              >
                {errors + warnings === 0 ? <IconCheck size={14} /> : <IconWarning size={14} />}
                {errors + warnings === 0 ? t('toolbar.valid') : t('toolbar.issues', { errors, warnings })}
              </button>
              <button
                ref={moreBtn}
                type="button"
                className="lxf-toolbar__more"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                title={t('toolbar.more')}
                onClick={() => setMoreOpen(o => !o)}
              >
                {t('toolbar.more')}
                <IconChevronDown size={13} />
              </button>
              <span className="lxf-toolbar__sep" aria-hidden="true" />
              <Button size="sm" icon={<IconSave />} title={t('toolbar.save.hint')} onClick={() => void actions.save()} disabled={!dirty || editor.saving} aria-busy={editor.saving}>
                {t('toolbar.save')}
              </Button>
              <Button size="sm" variant="primary" icon={<IconPlay />} disabled={!canRun} title={runTitle ?? t('toolbar.run.hint')} onClick={startRun}>
                {t('toolbar.run')}
              </Button>
              <span className="lxf-toolbar__sep" aria-hidden="true" />
              <span className="lxf-toolbar__panel">
                <IconButton
                  label={rightOpen ? t('panel.collapse') : panelHint ? t('panel.expandHint') : t('panel.expand')}
                  icon={<IconSidebarRight />}
                  aria-controls="lxf-inspector-panel"
                  aria-expanded={rightOpen}
                  onClick={togglePanel}
                />
                {panelHint && !rightOpen && <span className="lxf-toolbar__hint" aria-hidden="true" />}
              </span>
            </div>
            <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchor={moreBtn} label={t('toolbar.more')} align="end" width={290}>
              <ul className="lxf-menu" role="menu" aria-label={t('toolbar.more')}>
                {(
                  [
                    { key: 'layout', icon: <IconLayout />, run: actions.layout },
                    { key: 'triggers', icon: <IconClock />, run: () => setDialog('triggers') },
                    { key: 'history', icon: <IconHistory />, run: () => showTab('history', true) },
                    { key: 'export', icon: <IconDownload />, run: () => void download() },
                  ] as const
                ).map(item => (
                  <li key={item.key} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="lxf-menu__item"
                      onClick={() => {
                        setMoreOpen(false)
                        item.run()
                      }}
                    >
                      <span className="lxf-menu__icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="lxf-menu__text">
                        <span className="lxf-menu__label">{t(`toolbar.${item.key}` as never)}</span>
                        <span className="lxf-menu__hint">{t(`toolbar.${item.key}.hint` as never)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Popover>
            <Popover open={issuesOpen} onClose={() => setIssuesOpen(false)} anchor={issuesBtn} label={t('issues.title')} width={340}>
              {issues.length === 0 ? (
                <p className="lxf-muted lxf-pad">{t('issues.none')}</p>
              ) : (
                <ul className="lxf-issues">
                  {issues.map((issue, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className={cx('lxf-issue', `is-${issue.level}`)}
                        onClick={() => {
                          if (issue.nodeId) actions.select({ kind: 'node', id: issue.nodeId })
                          else if (issue.edgeId) actions.select({ kind: 'edge', id: issue.edgeId })
                          showTab('inspect')
                          setIssuesOpen(false)
                        }}
                      >
                        <IconWarning size={13} />
                        <span>
                          {issue.nodeId && <strong>{wf.nodes.find(n => n.id === issue.nodeId)?.name ?? issue.nodeId}: </strong>}
                          {issueText(t, issue)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Popover>
            {!showRun && unreviewed && editor.review && (
              <ReviewBanner t={t} review={editor.review} dirty={dirty} busy={editor.approving || editor.saving} onApprove={() => void actions.approve()} />
            )}
            {!showRun && <Palette t={t} scriptsAllowed={scriptsAllowed} onAdd={type => addNode(type)} />}
            <Canvas
              key={`${wf.id}:${showRun ? activeRun?.id : 'edit'}`}
              workflow={showRun && activeRun ? activeRun.snapshot : wf}
              issues={showRun ? [] : issues}
              selection={showRun ? (runs.focusNode ? { kind: 'node', id: runs.focusNode } : null) : editor.selection}
              run={showRun ? activeRun : null}
              readOnly={showRun}
              t={t}
              onMoveNode={(id, position) => actions.updateWorkflow(w => ({ ...w, nodes: w.nodes.map(n => (n.id === id ? { ...n, position: { x: Math.round(position.x), y: Math.round(position.y) } } : n)) }))}
              onConnect={actions.connectNodes}
              onSelect={sel => {
                if (showRun) actions.focusRunNode(sel?.kind === 'node' ? sel.id : null)
                else {
                  actions.select(sel)
                  if (sel) showTab('inspect')
                }
              }}
              onOpenNode={id => {
                if (showRun) actions.focusRunNode(id)
                else {
                  actions.select({ kind: 'node', id })
                  setTab('inspect')
                }
                openPanel()
              }}
              onDelete={({ nodes, edges }) =>
                actions.updateWorkflow(w => ({ ...w, nodes: w.nodes.filter(n => !nodes.includes(n.id)), edges: w.edges.filter(e => !edges.includes(e.id) && !nodes.includes(e.source) && !nodes.includes(e.target)) }))
              }
              onDropNode={(type, position) => addNode(type, position)}
              onReady={api => {
                centre.current = api.centre
              }}
            />
            {showRun && <div className="lxf-runbanner" role="status">{t('canvas.runMode', { status: t(`status.${activeRun!.status}` as never) })}</div>}
          </ReactFlowProvider>
        )}
      </section>

      {wf && !panelHidden && resizer('right')}

      {wf && (
        <aside ref={panelEl} id="lxf-inspector-panel" className="lxf-glass lxf-panel" aria-label={t('panel.aria')} hidden={panelHidden}>
          <div className="lxf-panel__head">
            <Segmented<PanelTab>
              label={t('panel.aria')}
              value={tab}
              onChange={setTab}
              className="lxf-panel__tabs"
              options={[
                { value: 'inspect', label: t('panel.inspect') },
                { value: 'run', label: activeRun && ACTIVE_RUN.includes(activeRun.status) ? t('panel.runLive') : t('panel.run') },
                { value: 'history', label: t('panel.history') },
              ]}
            />
            <IconButton className="lxf-collapse" label={t('panel.collapse')} icon={<IconChevronRight size={14} />} aria-controls="lxf-inspector-panel" aria-expanded onClick={() => panels.setOpen('right', false)} />
          </div>
          <div className="lxf-panel__body">
            {tab === 'inspect' &&
              (selectedNode ? (
                <Inspector
                  key={selectedNode.id}
                  workflow={wf}
                  node={selectedNode}
                  issues={issues.filter(i => i.nodeId === selectedNode.id)}
                  kernels={kernels}
                  scriptsAllowed={scriptsAllowed}
                  t={t}
                  onChange={node => actions.updateWorkflow(w => ({ ...w, nodes: w.nodes.map(n => (n.id === node.id ? node : n)) }))}
                  onWorkflowChange={actions.updateWorkflow}
                  onConnect={actions.connectNodes}
                  onDelete={actions.deleteSelection}
                />
              ) : selectedEdge ? (
                <EdgeInspector workflow={wf} edge={selectedEdge} t={t} onChange={edge => actions.updateWorkflow(w => ({ ...w, edges: w.edges.map(e => (e.id === edge.id ? edge : e)) }))} onDelete={actions.deleteSelection} />
              ) : (
                <WorkflowSettings workflow={wf} t={t} onChange={actions.updateWorkflow} />
              ))}
            {tab === 'run' &&
              (activeRun ? (
                <RunInspector
                  run={activeRun}
                  focusNode={runs.focusNode}
                  t={t}
                  onFocusNode={actions.focusRunNode}
                  onCancel={() => void actions.cancelRun(activeRun.id)}
                  onResume={() => void actions.resumeRun(activeRun.id)}
                  onRerun={() => void actions.rerun(activeRun.id)}
                  onDecide={(nodeId, approved, note) => void actions.decide(activeRun.id, nodeId, approved, note)}
                />
              ) : (
                <Empty title={t('run.none')} detail={t('run.noneDetail')} action={<Button variant="primary" size="sm" icon={<IconPlay />} disabled={!canRun} title={runTitle} onClick={startRun}>{t('toolbar.run')}</Button>} />
              ))}
            {tab === 'history' && (
              <RunHistory
                runs={wfRuns}
                activeId={activeRun?.id ?? null}
                t={t}
                locale={locale}
                onOpen={id => {
                  void actions.openRun(id).then(() => showTab('run'))
                }}
              />
            )}
          </div>
        </aside>
      )}

      <GenerateDialog open={dialog === 'generate'} onClose={() => setDialog(null)} t={t} onGenerate={actions.generate} />
      <ImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} t={t} onImport={actions.importJson} />
      {wf && <RunDialog open={dialog === 'run'} onClose={() => setDialog(null)} t={t} workflow={wf} onRun={inputs => void actions.run(inputs).then(() => showTab('run'))} />}
      {wf && (
        <TriggersDialog
          open={dialog === 'triggers'}
          onClose={() => setDialog(null)}
          t={t}
          locale={locale}
          workflow={wf}
          webhook={editor.webhook}
          onChange={actions.updateWorkflow}
          onRotate={actions.rotateWebhook}
          onRevoke={actions.deleteWebhook}
          onPreview={actions.cronPreview}
          onRunNow={() => setDialog((wf.inputs?.length ?? 0) > 0 ? 'run' : (void actions.run({}).then(() => showTab('run')), null))}
        />
      )}
    </div>
  )
}

/** Why the open workflow cannot run yet, with the one action that fixes it. */
export function ReviewBanner({ t, review, dirty, busy, onApprove }: { t: Translate; review: ReviewInfo; dirty: boolean; busy: boolean; onApprove: () => void }): ReactElement {
  const reason =
    review.by !== undefined ? 'review.changed' : review.source === 'model' ? 'review.model' : review.source === 'generated' ? 'review.generated' : review.source === 'import' ? 'review.import' : 'review.legacy'
  return (
    <div className="lxf-reviewbar" role="region" aria-label={t('review.aria')} aria-live="polite">
      <IconShield size={16} className="lxf-reviewbar__icon" aria-hidden="true" />
      <div className="lxf-reviewbar__text">
        <strong>{t(reason)}</strong>
        <span>{t('review.detail')}</span>
      </div>
      <Button size="sm" variant="primary" icon={<IconCheck size={14} />} disabled={busy} aria-busy={busy} onClick={onApprove}>
        {dirty ? t('review.approveUnsaved') : t('review.approve')}
      </Button>
    </div>
  )
}
