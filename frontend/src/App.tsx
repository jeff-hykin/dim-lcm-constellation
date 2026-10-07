// The constellation page: the graph (graph.ts) plus its toolbar, layout tabs, topics table, workers panel and module
// card. Everything shared (pause, layout, sort, filter, panels, pinned card) is backend state changed through
// api/settings, api/pause, api/resume, so the agent and the page drive the same view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { call, events } from "./api.ts"
import { accentVar, agoText, heatColor, heatFracLog, human, humanBits, humanSecs, transportLabel } from "./format.ts"
import { FlowGraph, LAYOUTS, type Node } from "./graph.ts"
import { Icon } from "./icons.tsx"
import { onThemeChange } from "./dim-app/theme.js"
import { EmptyState } from "./dim-app/react.js"
import { getZenoh } from "./dim-app/zenoh.js"
import type { Graph, Settings, State, TopicRow, Totals, WorkerStats, WorkersView } from "./types.ts"

// Desktop's blueprint Details embeds this page as its module graph (?embed&blueprint=<name>): just the graph, titled
// Module Graph, the layouts and a workers toggle at the bottom right, and that blueprint drawn from its wiring when it
// isn't the one running. Module clicks go to Desktop (postMessage), which can light modules and topics here
// (constellation:ready says this page listens).
const PARAMS = new URLSearchParams(location.search)
const EMBED = PARAMS.has("embed")
const EMBED_BLUEPRINT = PARAMS.get("blueprint") ?? ""

const DEFAULT_SETTINGS: Settings = {
    layout: "hierarchy",
    sort: "bps",
    filter: "",
    transport: "all",
    showTopics: true,
    showWorkers: true,
    pinnedModule: null,
}

export function App() {
    const host = useRef<HTMLDivElement>(null)
    const graphRef = useRef<FlowGraph | null>(null)
    const [graph, setGraph] = useState<Graph | null>(null)
    // embedded: the asked-for blueprint from its wiring, drawn while it isn't the one running
    const [staticGraph, setStaticGraph] = useState<Graph | null>(null)
    const [staticFailed, setStaticFailed] = useState(false)
    const [workersOpen, setWorkersOpen] = useState(false)
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
    const [paused, setPaused] = useState(false)
    const [totals, setTotals] = useState<Totals | null>(null)
    const [table, setTable] = useState<TopicRow[]>([])
    const [workers, setWorkers] = useState<WorkersView | null>(null)
    const [lastStatsAt, setLastStatsAt] = useState(0)
    const [hovered, setHovered] = useState<Node | null>(null)
    const [error, setError] = useState<string | null>(null)
    // the first-run message: the server unreachable, the zenoh-gateway link lost
    const [backendDown, setBackendDown] = useState(false)
    const [linkLost, setLinkLost] = useState(false)
    const [, setTick] = useState(0)
    // inline heat colors depend on the palette: re-render on a theme switch
    useEffect(() => {
        const off = onThemeChange(() => setTick((t) => t + 1))
        return () => {
            off()
        }
    }, [])

    const act = useCallback((promise: Promise<unknown>) => {
        promise.then(() => setError(null), (e) => setError(e.message))
    }, [])
    const change = useCallback((patch: Partial<Settings>) => act(call("POST", "api/settings", patch)), [act])

    // the graph engine lives outside React's tree
    useLayoutEffect(() => {
        const flow = new FlowGraph(host.current!, {
            onHover: (node) => setHovered(node?.kind === "module" ? node : null),
            onClick: (node) => {
                if (node.kind === "module" && EMBED && parent !== window) {
                    parent.postMessage(
                        { type: "constellation:module", module: node.id.replace(/^m:/, "") },
                        location.origin,
                    )
                } else if (node.kind === "module") {
                    const id = node.id.replace(/^m:/, "")
                    call("POST", "api/settings", { pinnedModule: settingsRef.current.pinnedModule === id ? null : id })
                        .catch((e) => setError(e.message))
                }
            },
        })
        graphRef.current = flow
        return () => flow.destroy()
    }, [])
    const settingsRef = useRef(settings)
    settingsRef.current = settings
    const graphStateRef = useRef(graph)
    graphStateRef.current = graph

    // initial state, then the backend's events (and the state again after the zenoh-gateway link comes back)
    useEffect(() => {
        const load = () => {
            call<Graph>("GET", "api/graph").then((g) => {
                setBackendDown(false)
                setGraph(g)
            }, () => setBackendDown(true))
            call<State>("GET", "api/state").then((s) => {
                setSettings(s.settings)
                setPaused(s.paused)
                setTotals(s.totals)
                graphRef.current!.paused = s.paused
            }, (e) => setError(e.message))
        }
        load()
        const socket = events((event) => {
            const flow = graphRef.current!
            switch (event.type) {
                case "graph":
                    setGraph(event.graph)
                    break
                case "packets":
                    flow.pulse(event.events)
                    break
                case "stats":
                    setTotals(event.totals)
                    setTable(event.table)
                    setWorkers(event.workers)
                    setLastStatsAt(Date.now())
                    flow.applyStats(event.topics)
                    break
                case "workers":
                    setWorkers({ live: event.live, ageMs: event.ageMs, data: event.data })
                    break
                case "settings":
                    setSettings(event.settings)
                    break
                case "paused":
                    setPaused(event.paused)
                    flow.paused = event.paused
                    break
                case "reset":
                    setTable([])
                    flow.applyStats([])
                    break
                case "view-request":
                    if (!document.hidden) {
                        const s = settingsRef.current
                        const counts = flow.counts()
                        const header = `${
                            graphStateRef.current?.blueprint || "no running blueprint"
                        } · ${counts.modules} modules · ${counts.topics} topics · layout ${s.layout}${
                            s.filter ? ` · filter "${s.filter}"` : ""
                        }`
                        socket.send({ type: "view", id: event.id, png: flow.renderPng(header) })
                    }
                    break
            }
        }, (connected) => {
            setLinkLost(!connected)
            if (connected) {
                load()
            }
        })
        // a blueprint started or stopped: re-read it now instead of on the backend's next 4 s rescan
        const offRuns = getZenoh().subscribeDesktop("runs", () => {
            call("POST", "api/graph/refresh").catch(() => {})
        })
        return () => {
            offRuns()
            socket.stop()
        }
    }, [])

    useEffect(() => {
        if (!EMBED_BLUEPRINT) {
            return
        }
        call<Graph>("GET", `api/graph/blueprint?name=${encodeURIComponent(EMBED_BLUEPRINT)}`).then(
            setStaticGraph,
            (e) => {
                setStaticFailed(true)
                setError(e.message)
            },
        )
    }, [])
    const shown = EMBED_BLUEPRINT && graph?.blueprint !== EMBED_BLUEPRINT ? staticGraph : graph
    useEffect(() => {
        if (shown) {
            graphRef.current?.applyGraph(shown)
        }
    }, [shown])

    // Desktop lights a module or a topic: {type: "constellation:focus", module?, topic?} (neither clears it)
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.origin === location.origin && event.data?.type === "constellation:focus") {
                const { module, topic } = event.data
                graphRef.current?.spotlight(module || topic ? { module, topic } : null)
            }
        }
        addEventListener("message", onMessage)
        // listening now: Desktop sends what to light
        if (EMBED && parent !== window) {
            parent.postMessage({ type: "constellation:ready" }, location.origin)
        }
        return () => removeEventListener("message", onMessage)
    }, [])

    // settings → the graph engine
    useEffect(() => {
        const flow = graphRef.current!
        if (flow.layoutId !== settings.layout) {
            flow.setLayout(settings.layout)
        }
        flow.setFilter(settings.filter)
    }, [settings.layout, settings.filter])

    // a 400 ms tick: "ago" texts, the module card's live rates, the connection readout
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 400)
        return () => clearInterval(timer)
    }, [])

    const cycleLayout = useCallback((direction: number) => {
        const i = LAYOUTS.findIndex((l) => l.id === settingsRef.current.layout)
        change({ layout: LAYOUTS[(i + direction + LAYOUTS.length) % LAYOUTS.length].id })
    }, [change])

    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            if ((ev.target as Element)?.closest?.("input, textarea, select")) {
                return
            }
            const s = settingsRef.current
            if (ev.key === " ") {
                ev.preventDefault()
                act(call("POST", graphRef.current!.paused ? "api/resume" : "api/pause"))
            } else if (ev.key === "d") {
                EMBED ? setWorkersOpen((open) => !open) : change({ showWorkers: !s.showWorkers })
            } else if (ev.key === "t") {
                change({ showTopics: !s.showTopics })
            } else if (ev.key === "f" || ev.key === "0") {
                graphRef.current!.fitView()
            } else if (ev.key === "g") {
                cycleLayout(1)
            } else if (ev.key === "G") {
                cycleLayout(-1)
            }
        }
        addEventListener("keydown", onKey)
        return () => removeEventListener("keydown", onKey)
    }, [act, change, cycleLayout])

    const flow = graphRef.current
    const counts = flow?.counts() ?? { modules: 0, topics: 0 }
    const live = Date.now() - lastStatsAt < 4000
    const cardModule = settings.pinnedModule ? `m:${settings.pinnedModule}` : hovered?.id ?? null
    const empty = counts.modules === 0
    const launcher = { kind: "blueprint" as const }
    const retry = () => location.reload()
    const drawn = EMBED_BLUEPRINT && staticGraph
    const onboarding = backendDown
        ? {
            testId: "onboard-backend-down",
            label: "Server not answering",
            tone: "warn" as const,
            title: "The Constellation server isn't answering",
            body: "Restarting the app usually fixes it: close it with ✕ and open it again.",
            actions: [{ label: "Try again", onClick: retry }],
        }
        : drawn
        ? null
        // embedded for a blueprint: its graph is still on the way, so it isn't "nothing running" yet
        : EMBED_BLUEPRINT && !staticFailed
        ? { testId: "onboard-loading", title: "Loading", busy: true }
        : linkLost && empty
        ? {
            testId: "onboard-link-lost",
            label: "No data link",
            tone: "warn" as const,
            title: "Can't reach the robot data gateway",
            body: "Desktop's zenoh-gateway is down or blocked. This page reconnects by itself when it's back.",
            actions: [{ label: "Open Settings", app: "settings" }, { label: "Try again", onClick: retry }],
        }
        : !graph || graph.blueprint && !empty
        ? null
        : graph.unknown
        ? {
            testId: "onboard-no-metadata",
            label: `${graph.blueprint} is running`,
            title: `Desktop can't see ${graph.blueprint}'s modules`,
            body:
                "Its blueprint isn't in the dimOS checkout Desktop uses, so there's no module list to draw. Point Desktop at that checkout in Settings.",
            actions: [{ label: "Open Settings", app: "settings" }],
        }
        : {
            testId: "onboard-no-blueprint",
            label: "No blueprint running",
            title: "Nothing is running yet",
            body: "Start a blueprint (or a replay, no robot needed) and its modules and topics light up here.",
            actions: [{ label: "Open the Launcher", app: "launcher", params: launcher }],
        }

    return (
        <>
            <div ref={host} />
            {onboarding && <EmptyState layer {...onboarding} />}

            {EMBED
                ? (
                    <div className="bar dim-panel glass" id="toolbar">
                        <span className="logo dim-title">Module Graph</span>
                    </div>
                )
                : <Toolbar counts={counts} totals={totals} paused={paused} live={live} act={act} />}

            <div className={`bar dim-tabs${EMBED ? " corner" : ""}`} id="layouts" role="tablist">
                {LAYOUTS.map((l) => (
                    <button
                        type="button"
                        key={l.id}
                        className={`dim-tab${settings.layout === l.id ? " on" : ""}`}
                        role="tab"
                        aria-selected={settings.layout === l.id}
                        title={`${l.label} layout`}
                        onClick={() => change({ layout: l.id })}
                    >
                        {l.label}
                    </button>
                ))}
                {EMBED && (
                    <button
                        type="button"
                        className={`dim-tab workers-toggle${workersOpen ? " on" : ""}`}
                        aria-pressed={workersOpen}
                        title="each worker's CPU and memory (D)"
                        onClick={() => setWorkersOpen(!workersOpen)}
                        data-workers-toggle
                    >
                        Workers
                    </button>
                )}
            </div>
            <div className="bar dim-panel glass" id="controls">
                <button
                    type="button"
                    className="dim-btn ghost icon"
                    title="zoom in"
                    onClick={() => flow?.zoomAt(innerWidth / 2, innerHeight / 2, 1.2)}
                >
                    <Icon name="plus" />
                </button>
                <button
                    type="button"
                    className="dim-btn ghost icon"
                    title="zoom out"
                    onClick={() => flow?.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2)}
                >
                    <Icon name="minus" />
                </button>
                <button
                    type="button"
                    className="dim-btn ghost icon fit"
                    title="fit view"
                    onClick={() => flow?.fitView()}
                >
                    Fit
                </button>
            </div>

            {!EMBED && (
                <>
                    <div id="legend">
                        <span className="k">
                            <span className="sw mod" /> module
                        </span>
                        <span className="k">
                            <span className="sw top" /> topic
                        </span>
                    </div>
                    <TopicsPanel settings={settings} table={table} change={change} />
                </>
            )}
            <WorkersPanel show={EMBED ? workersOpen : settings.showWorkers} workers={workers} />
            {flow && cardModule && <ModuleCardView flow={flow} id={cardModule} pinned={!!settings.pinnedModule} />}

            {error && (
                <div className="dim-alert danger" id="error" onClick={() => setError(null)}>
                    {error}
                </div>
            )}
            {!EMBED && (
                <div id="help">
                    DRAG pan · SCROLL zoom · HOVER module for card · CLICK pin · SPACE pause · G cycle layout · T topics
                    · D workers
                </div>
            )}
        </>
    )
}

/** The standalone page's header: counts, total rate, pause and the live readout. */
function Toolbar({ counts, totals, paused, live, act }: {
    counts: { modules: number; topics: number }
    totals: Totals | null
    paused: boolean
    live: boolean
    act: (promise: Promise<unknown>) => void
}) {
    return (
        <div className="bar dim-panel glass" id="toolbar">
            <span className="logo dim-title">Module flow</span>
            <span className="sep" />
            <span className="readout">
                <b>{counts.modules}</b> modules · <b>{counts.topics}</b> topics
            </span>
            <span className="readout">
                <b>{(totals?.hz ?? 0).toFixed(1)}</b> Hz · <b>{human(totals?.bytesPerSec ?? 0)}</b>/s
            </span>
            <span className="sep" />
            <button
                type="button"
                className="dim-btn ghost icon"
                id="pause"
                title={paused ? "resume (space)" : "pause (space)"}
                onClick={() => act(call("POST", paused ? "api/resume" : "api/pause"))}
            >
                <Icon name={paused ? "play" : "pause"} size={14} />
            </button>
            <span id="conn" className={paused ? "paused" : live ? "live" : ""}>
                {paused ? "❚❚ paused" : live ? "● live" : "○ waiting for run"}
            </span>
        </div>
    )
}

function TopicsPanel(
    { settings, table, change }: { settings: Settings; table: TopicRow[]; change: (patch: Partial<Settings>) => void },
) {
    const [collapsed, setCollapsed] = useState(false)
    const [filter, setFilter] = useState(settings.filter)
    useEffect(() => setFilter(settings.filter), [settings.filter])
    // the filter is shared state: send it once typing pauses
    useEffect(() => {
        if (filter === settings.filter) {
            return
        }
        const timer = setTimeout(() => change({ filter }), 250)
        return () => clearTimeout(timer)
    }, [filter, settings.filter, change])
    const rows = table.filter((r) => !r.declaredOnly)
    const liveRows = rows.filter((r) => r.hz > 0)
    const maxHz = Math.max(0, ...liveRows.map((r) => r.hz))
    const maxBps = Math.max(0, ...liveRows.map((r) => r.bytesPerSec))
    const sortKey = (key: Settings["sort"], label: string) => (
        <span
            className={`${key === "hz" ? "hz" : "tp"} sortkey${settings.sort === key ? " active" : ""}`}
            onClick={() => change({ sort: key })}
        >
            {label} <Icon className="sort-ind" name="chevron-down" size={10} />
        </span>
    )
    return (
        <div
            className={`bar dim-panel glass${settings.showTopics ? "" : " hide"}${collapsed ? " collapsed" : ""}`}
            id="topics"
        >
            <h2 className="dim-label" onClick={() => setCollapsed(!collapsed)}>
                <span className="thd">
                    <Icon className="caret" name="chevron-down" /> Topics · Rate
                </span>{" "}
                <span id="topics-count">{rows.length}</span>
            </h2>
            <div className="filter">
                <input
                    className="dim-input"
                    placeholder="filter topics"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="filter topics"
                />
                <select
                    className="dim-select"
                    value={settings.transport}
                    onChange={(e) => change({ transport: e.target.value as Settings["transport"] })}
                    aria-label="transport"
                >
                    <option value="all">all</option>
                    <option value="lcm">Multicast</option>
                    <option value="zenoh">Zenoh</option>
                </select>
            </div>
            <div className="thead" title="click a column to sort">
                <span className="sp" />
                <span
                    className={`n sortkey${settings.sort === "name" ? " active" : ""}`}
                    onClick={() => change({ sort: "name" })}
                >
                    TOPIC
                </span>
                {sortKey("hz", "Hz")}
                {sortKey("bps", "bit/s")}
            </div>
            <div className="body">
                {rows.length
                    ? rows.map((r) => {
                        const isLive = r.hz > 0
                        const ago = r.lastSeenMsAgo === null ? "—" : agoText(r.lastSeenMsAgo)
                        return (
                            <div
                                key={`${r.transport} ${r.topic}`}
                                className={`trow ${isLive ? "live" : "idle"}`}
                                style={{ "--node-accent": `var(${accentVar(r.topic)})` } as React.CSSProperties}
                                title={`${r.topic} (${transportLabel(r.transport)}) · ${r.messages} msg${
                                    r.messages === 1 ? "" : "s"
                                } · avg ${human(r.avgMessageBytes)} · last ${ago}`}
                            >
                                <span className="dot" />
                                <span className="n">{r.name}</span>
                                <span className="hz">
                                    {isLive
                                        ? (
                                            <>
                                                <b style={{ color: heatColor(heatFracLog(r.hz, maxHz)) }}>
                                                    {r.hz.toFixed(1)}
                                                </b>{" "}
                                                Hz
                                            </>
                                        )
                                        : <span className="ago">{ago}</span>}
                                </span>
                                <span
                                    className="tp"
                                    style={isLive
                                        ? { color: heatColor(heatFracLog(r.bytesPerSec, maxBps)) }
                                        : undefined}
                                >
                                    {isLive ? humanBits(r.bytesPerSec) : "—"}
                                </span>
                            </div>
                        )
                    })
                    : (
                        <div className="empty">
                            {settings.filter
                                ? "no topics match the filter"
                                : "no topics yet: they appear a few seconds after a blueprint starts"}
                        </div>
                    )}
            </div>
        </div>
    )
}

type WorkerRow = { role: string; alive: boolean; cpu: number; mem: number; raw: WorkerStats }

function WorkersPanel({ show, workers }: { show: boolean; workers: WorkersView | null }) {
    const [collapsed, setCollapsed] = useState(false)
    const [tip, setTip] = useState<{ row: WorkerRow; top: number } | null>(null)
    const panel = useRef<HTMLDivElement>(null)
    const rows: WorkerRow[] = []
    const data = workers?.data
    if (data) {
        const add = (role: string, x: WorkerStats, alive: boolean) =>
            rows.push({ role, alive, cpu: x.cpu_percent || 0, mem: x.pss || 0, raw: x })
        if (data.coordinator) {
            add("coordinator", data.coordinator, true)
        }
        for (const w of data.workers || []) {
            const mods = Array.isArray(w.modules) ? w.modules.filter(Boolean) : []
            add(mods.length ? mods.join(", ") : `worker ${w.worker_id ?? "?"}`, w, w.alive !== false)
        }
    }
    const maxMem = Math.max(0, ...rows.map((r) => r.mem))
    const live = !!workers?.live
    const panelRect = panel.current?.getBoundingClientRect()
    return (
        <>
            <div
                ref={panel}
                className={`bar dim-panel glass${show ? " show" : ""}${collapsed ? " collapsed" : ""}`}
                id="dtop"
            >
                <h2 className="dim-label" onClick={() => setCollapsed(!collapsed)}>
                    <span className="thd">
                        <Icon className="caret" name="chevron-down" /> Workers · CPU/RAM
                    </span>{" "}
                    <span style={{ color: live ? "var(--info)" : "var(--muted-fg)" }}>
                        {live ? "● live" : "○ no stream"}
                    </span>
                </h2>
                <div className="body" onMouseLeave={() => setTip(null)}>
                    {rows.length
                        ? rows.map((r) => (
                            <div
                                className="row"
                                key={r.role}
                                onMouseOver={(e) =>
                                    setTip({ row: r, top: e.currentTarget.getBoundingClientRect().top })}
                            >
                                <span className="n" style={r.alive ? undefined : { opacity: 0.5 }}>{r.role}</span>
                                <span className="c">
                                    <b style={{ color: heatColor(Math.min(1, r.cpu / 100)) }}>{r.cpu.toFixed(0)}</b>%
                                </span>
                                <span className="c" style={{ color: heatColor(heatFracLog(r.mem, maxMem)) }}>
                                    {human(r.mem)}
                                </span>
                            </div>
                        ))
                        : (
                            <div className="empty">
                                launch a blueprint with <b>--dtop</b>
                            </div>
                        )}
                </div>
            </div>
            {tip && panelRect && (
                <WorkerTip row={rows.find((r) => r.role === tip.row.role) ?? tip.row} top={tip.top} panel={panelRect} />
            )}
        </>
    )
}

/** every field the worker reports, mirroring the `dimos dtop` TUI */
function WorkerTip({ row, top, panel }: { row: WorkerRow; top: number; panel: DOMRect }) {
    const x = row.raw
    const kv = (label: string, value: string | number) => (
        <span key={label}>
            {label} <b>{value}</b>
        </span>
    )
    const width = 250
    let left = panel.left - width - 10
    if (left < 8) {
        left = panel.right + 10
    }
    if (left + width > innerWidth - 8) {
        left = innerWidth - 8 - width
    }
    return (
        <div
            className="dim-panel show"
            id="dtop-tip"
            style={{ left: Math.max(8, left), top: Math.max(8, Math.min(top, innerHeight - 140)) }}
        >
            <div className="th">
                <span className="role" style={row.alive ? undefined : { opacity: 0.5 }}>{row.role}</span>
                {x.alive === false && <span style={{ color: "var(--warn)", fontSize: 9 }}>dead</span>}
                <span className="pid">pid {x.pid ?? "—"}</span>
            </div>
            {x.worker_id != null && <div className="mods">worker {x.worker_id}{x.dedicated ? " · dedicated" : ""}</div>}
            <div className="kv">
                {kv("CPU", `${(x.cpu_percent ?? 0).toFixed(0)}%`)}
                {kv("PSS", human(x.pss ?? 0))}
                {kv("Thr", x.num_threads ?? "—")}
                {kv("Child", x.num_children ?? "—")}
                {kv("FDs", x.num_fds ?? "—")}
                {kv("UserT", humanSecs(x.cpu_time_user))}
                {kv("SysT", humanSecs(x.cpu_time_system))}
                {kv("ioT", humanSecs(x.cpu_time_iowait))}
                {kv("IO↓", human(x.io_read_bytes ?? 0))}
                {kv("IO↑", human(x.io_write_bytes ?? 0))}
            </div>
            {Array.isArray(x.children) && x.children.length > 0 && (
                <div className="ch">
                    <div className="chd dim-label">Child procs {x.children.length}</div>
                    {x.children.map((c, i) => (
                        <div className="crow" key={i}>
                            <span className="cn">
                                {c.name || "?"} <span style={{ color: "var(--muted-fg)" }}>{c.pid ?? ""}</span>
                            </span>
                            <span className="cp">{(c.cpu_percent ?? 0).toFixed(0)}%</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

/** A launcher-style card for a module: docstring, typed streams with live rates, skills, RPCs. Hover shows it; a
 * click pins it (shared: api/settings pinnedModule). */
function ModuleCardView({ flow, id, pinned }: { flow: FlowGraph; id: string; pinned: boolean }) {
    const card = useRef<HTMLDivElement>(null)
    const node = flow.nodes.get(id)
    const info = flow.moduleInfo.get(id)
    const [position, setPosition] = useState({ left: -1000, top: 0 })
    useLayoutEffect(() => {
        const r = flow.nodeRect(id)
        if (!r) {
            return
        }
        const cw = 300
        const gap = 12
        let left = r.right + gap
        if (left + cw > innerWidth - 8) {
            left = r.left - cw - gap
        }
        left = Math.max(8, left)
        const ch = card.current?.offsetHeight || 220
        const top = Math.max(8, Math.min(r.top, innerHeight - 8 - ch))
        if (left !== position.left || top !== position.top) {
            setPosition({ left, top })
        }
    })
    if (!node) {
        return null
    }
    const rate = (s: { name: string; wire?: string }) => {
        const stat = flow.streamRate(s.wire || s.name)
        if (stat && stat.hz > 0.05) {
            return <span className="rt">{stat.hz.toFixed(1)}Hz</span>
        }
        return stat?.lastAt ? <span className="rt idle">{agoText(Date.now() - stat.lastAt)}</span> : null
    }
    const chips = (list: { name: string; type?: string; wire?: string }[], cls: string) =>
        list.length
            ? (
                <div className="chips">
                    {list.map((s) => (
                        <span className={`chip ${cls}`} key={s.name}>
                            {s.name}
                            {s.wire && <span className="rmp">↦ {s.wire}</span>}
                            <span className="ty">: {(s.type || "?").split(".").pop()}</span>
                            {rate(s)}
                        </span>
                    ))}
                </div>
            )
            : <span className="none">none</span>
    const methods = (list: { name: string; params?: { name: string }[]; return_type?: string }[]) =>
        list.map((f) => (
            <div className="mrow" key={f.name}>
                {f.name}({(f.params || []).map((p) => p.name).join(", ")})
                {f.return_type && <span className="ret">→ {f.return_type}</span>}
            </div>
        ))
    return (
        <div ref={card} className={`bar dim-panel show${pinned ? " pinned" : ""}`} id="card" style={position}>
            <div className="chd">
                <span className="dim-badge info">MOD</span>
                <span className="nm">{info?.label || node.label}</span>
                <span className="pin">{pinned && <Icon name="pin" size={13} />}</span>
            </div>
            <div className="cbody">
                {!info ? <span className="none">no blueprint metadata</span> : (
                    <>
                        {info.doc && <div className="doc">{info.doc}</div>}
                        <div className="sec">
                            <span className="lbl dim-label">Publishes {info.outputs.length}</span>
                            {chips(info.outputs, "out")}
                        </div>
                        <div className="sec">
                            <span className="lbl dim-label">Subscribes {info.inputs.length}</span>
                            {chips(info.inputs, "in")}
                        </div>
                        {info.skills.length > 0 && (
                            <div className="sec">
                                <span className="lbl dim-label">Skills</span>
                                {methods(info.skills)}
                            </div>
                        )}
                        {info.rpcs.length > 0 && (
                            <div className="sec">
                                <span className="lbl dim-label">RPCs</span>
                                {methods(info.rpcs)}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
