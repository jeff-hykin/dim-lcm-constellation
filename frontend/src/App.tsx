// The constellation page: the graph (graph.ts) plus its toolbar, layout tabs, topics table, workers panel and module
// card. Everything shared (pause, layout, sort, filter, panels, pinned card) is backend state changed through
// api/settings, api/pause, api/resume, so the agent and the page drive the same view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { call, events } from "./api.ts"
import { accentVar, agoText, heatColor, heatFracLog, human, humanBits, humanSecs, transportLabel } from "./format.ts"
import { FlowGraph, LAYOUTS, type Node } from "./graph.ts"
import { openApp } from "./dim-app/source/desktop.js"
import { getZenoh } from "./dim-app/source/zenoh.js"
import {
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Hud,
    Icon,
    IconButton,
    KeyHints,
    KeyValue,
    Label,
    Panel,
    Row,
    SearchInput,
    Select,
    Separator,
    Spinner,
    StatusDot,
    Table,
    Tabs,
    Text,
    Toolbar,
    Tooltip,
    useTheme,
} from "dimos-react"
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
    useTheme() // re-render on a skin change

    const act = useCallback((promise: Promise<unknown>) => {
        promise.then(() => setError(null), (e) => setError(e.message))
    }, [])
    const change = useCallback(
        (patch: Partial<Settings>) => act(call("POST", "api/settings", patch)),
        [act],
    )

    // the graph engine lives outside React's tree
    useLayoutEffect(() => {
        const flow = new FlowGraph(host.current!, {
            onHover: (node) => setHovered(node?.kind === "module" ? node : null),
            onClick: (node) => {
                if (node.kind === "module" && EMBED && parent !== window) {
                    parent.postMessage(
                        {
                            type: "constellation:module",
                            module: node.id.replace(/^m:/, ""),
                        },
                        location.origin,
                    )
                } else if (node.kind === "module") {
                    const id = node.id.replace(/^m:/, "")
                    call("POST", "api/settings", {
                        pinnedModule: settingsRef.current.pinnedModule === id ? null : id,
                    })
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
                    setWorkers({
                        live: event.live,
                        ageMs: event.ageMs,
                        data: event.data,
                    })
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
                        socket.send({
                            type: "view",
                            id: event.id,
                            png: flow.renderPng(header),
                        })
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
        call<Graph>(
            "GET",
            `api/graph/blueprint?name=${encodeURIComponent(EMBED_BLUEPRINT)}`,
        ).then(
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
            if (
                event.origin === location.origin &&
                event.data?.type === "constellation:focus"
            ) {
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
        change({
            layout: LAYOUTS[(i + direction + LAYOUTS.length) % LAYOUTS.length].id,
        })
    }, [change])

    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            if ((ev.target as Element)?.closest?.("input, textarea, select")) {
                return
            }
            const s = settingsRef.current
            if (ev.key === " ") {
                ev.preventDefault()
                act(
                    call("POST", graphRef.current!.paused ? "api/resume" : "api/pause"),
                )
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
    const retry = () => location.reload()
    const drawn = EMBED_BLUEPRINT && staticGraph
    const openSettings = {
        label: "Open Settings",
        onClick: () => openApp("settings"),
    }
    const onboarding: Onboarding | null = backendDown
        ? {
            testId: "onboard-backend-down",
            tone: "warn",
            title: "The Constellation server isn't answering",
            message: "Restarting the app usually fixes it: close it with ✕ and open it again.",
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
            tone: "warn",
            title: "Can't reach the robot data gateway",
            message: "Desktop's zenoh-gateway is down or blocked. This page reconnects by itself when it's back.",
            actions: [openSettings, { label: "Try again", onClick: retry }],
        }
        : !graph || graph.blueprint && !empty
        ? null
        : graph.unknown
        ? {
            testId: "onboard-no-metadata",
            title: `Desktop can't see ${graph.blueprint}'s modules`,
            message:
                "Its blueprint isn't in the dimOS checkout Desktop uses, so there's no module list to draw. Point Desktop at that checkout in Settings.",
            actions: [openSettings],
        }
        : {
            testId: "onboard-no-blueprint",
            title: "Nothing is running yet",
            message: "Start a blueprint (or a replay, no robot needed) and its modules and topics light up here.",
            actions: [{
                label: "Open the Launcher",
                onClick: () => openApp("launcher"),
            }],
        }

    const layoutTabs = (
        <Tabs
            variant="pill"
            size="sm"
            label="layout"
            className="dr-glass"
            items={LAYOUTS.map((l) => ({
                value: l.id,
                label: l.label,
                title: `${l.label} layout`,
            }))}
            value={settings.layout}
            onChange={(layout: Settings["layout"]) => change({ layout })}
        />
    )
    return (
        <>
            <div ref={host} />
            {onboarding && (
                <EmptyState
                    layer
                    data-testid={onboarding.testId}
                    icon={onboarding.busy ? null : onboarding.tone === "warn" ? "warn" : "info"}
                    tone={onboarding.tone}
                    title={onboarding.title}
                    message={onboarding.message}
                    actions={onboarding.actions?.map((a, i) => (
                        <Button
                            key={a.label}
                            variant={i === 0 ? "primary" : "default"}
                            onClick={a.onClick}
                        >
                            {a.label}
                        </Button>
                    ))}
                >
                    {onboarding.busy && <Spinner />}
                </EmptyState>
            )}

            <Hud
                position="top-left"
                style={{ bottom: "calc(120px + var(--dim-inset-bottom, 0px))" }}
            >
                {EMBED
                    ? (
                        <Toolbar floating className="dr-glass">
                            <Text>Module Graph</Text>
                        </Toolbar>
                    )
                    : (
                        <StatusBar
                            counts={counts}
                            totals={totals}
                            paused={paused}
                            live={live}
                            act={act}
                        />
                    )}
                {!EMBED && layoutTabs}
                {!EMBED && settings.showTopics && <TopicsPanel settings={settings} table={table} change={change} />}
            </Hud>
            {(EMBED ? workersOpen : settings.showWorkers) && (
                <Hud position="top-right">
                    <WorkersPanel workers={workers} />
                </Hud>
            )}

            <Hud position="bottom-left">
                <Row gap={16} align="flex-end">
                    <Toolbar floating vertical className="dr-glass">
                        <IconButton
                            icon="plus"
                            size="sm"
                            label="zoom in"
                            onClick={() => flow?.zoomAt(innerWidth / 2, innerHeight / 2, 1.2)}
                        />
                        <IconButton
                            icon="minus"
                            size="sm"
                            label="zoom out"
                            onClick={() => flow?.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2)}
                        />
                        <IconButton
                            icon="fit"
                            size="sm"
                            label="fit view (F)"
                            onClick={() => flow?.fitView()}
                        />
                    </Toolbar>
                    {!EMBED && (
                        <Row gap={14}>
                            <Text small muted>
                                <span className="swatch module" /> module
                            </Text>
                            <Text small muted>
                                <span className="swatch topic" /> topic
                            </Text>
                        </Row>
                    )}
                </Row>
            </Hud>
            <Hud position="bottom-right">
                {EMBED
                    ? (
                        <Row gap={6} wrap justify="flex-end">
                            {layoutTabs}
                            <Button
                                size="sm"
                                pressed={workersOpen}
                                title="each worker's CPU and memory (D)"
                                onClick={() => setWorkersOpen(!workersOpen)}
                                data-workers-toggle
                            >
                                Workers
                            </Button>
                        </Row>
                    )
                    : (
                        <KeyHints
                            hints={[
                                ["drag", "pan"],
                                ["scroll", "zoom"],
                                ["click", "pin module"],
                                ["space", "pause"],
                                ["G", "layout"],
                                ["T", "topics"],
                                ["D", "workers"],
                            ]}
                        />
                    )}
            </Hud>

            {flow && cardModule && (
                <ModuleCardView
                    flow={flow}
                    id={cardModule}
                    pinned={!!settings.pinnedModule}
                />
            )}

            {error && (
                <Hud position="bottom" style={{ zIndex: 20 }}>
                    <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>
                </Hud>
            )}
        </>
    )
}

type Onboarding = {
    testId: string
    title: string
    tone?: "warn"
    message?: string
    busy?: boolean
    actions?: { label: string; onClick: () => void }[]
}

/** The standalone page's header: counts, total rate, pause and the live readout. */
function StatusBar({ counts, totals, paused, live, act }: {
    counts: { modules: number; topics: number }
    totals: Totals | null
    paused: boolean
    live: boolean
    act: (promise: Promise<unknown>) => void
}) {
    return (
        <Toolbar
            floating
            className="dr-glass"
            style={{ gap: 12, padding: "4px 10px" }}
        >
            <Text>Module flow</Text>
            <Separator vertical />
            <Text small muted>
                <Text mono>{counts.modules}</Text> modules · <Text mono>{counts.topics}</Text> topics
            </Text>
            <Text small muted>
                <Text mono>{(totals?.hz ?? 0).toFixed(1)}</Text> Hz ·{" "}
                <Text mono>{human(totals?.bytesPerSec ?? 0)}</Text>/s
            </Text>
            <Separator vertical />
            <IconButton
                id="pause"
                size="sm"
                icon={paused ? "play" : "pause"}
                label={paused ? "resume (space)" : "pause (space)"}
                onClick={() => act(call("POST", paused ? "api/resume" : "api/pause"))}
            />
            <Row gap={6} id="conn">
                <StatusDot
                    tone={paused ? "warn" : live ? "info" : "off"}
                    pulse={live && !paused}
                />
                <Text small muted>
                    {paused ? "paused" : live ? "live" : "waiting for run"}
                </Text>
            </Row>
        </Toolbar>
    )
}

const SORT_DIR: Record<string, "asc" | "desc"> = {
    name: "asc",
    hz: "desc",
    bps: "desc",
    messages: "desc",
}

function TopicsPanel(
    { settings, table, change }: {
        settings: Settings
        table: TopicRow[]
        change: (patch: Partial<Settings>) => void
    },
) {
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
    const columns = [
        {
            key: "name",
            label: "Topic",
            sort: true,
            render: (r: TopicRow) => {
                const ago = r.lastSeenMsAgo === null ? "—" : agoText(r.lastSeenMsAgo)
                return (
                    <Row
                        gap={6}
                        title={`${r.topic} (${transportLabel(r.transport)}) · ${r.messages} msg${
                            r.messages === 1 ? "" : "s"
                        } · avg ${human(r.avgMessageBytes)} · last ${ago}`}
                    >
                        <StatusDot
                            tone="off"
                            style={{
                                background: `var(${accentVar(r.topic)})`,
                                opacity: r.hz > 0 ? 1 : 0.4,
                            }}
                        />
                        <Text mono small muted={r.hz === 0}>{r.name}</Text>
                    </Row>
                )
            },
        },
        {
            key: "hz",
            label: "Hz",
            sort: true,
            align: "right",
            render: (r: TopicRow) =>
                r.hz > 0
                    ? (
                        <Text
                            mono
                            small
                            style={{ color: heatColor(heatFracLog(r.hz, maxHz)) }}
                        >
                            {r.hz.toFixed(1)}
                        </Text>
                    )
                    : (
                        <Text mono small muted style={{ whiteSpace: "nowrap" }}>
                            {r.lastSeenMsAgo === null ? "—" : agoText(r.lastSeenMsAgo)}
                        </Text>
                    ),
        },
        {
            key: "bps",
            label: "bit/s",
            sort: true,
            align: "right",
            render: (r: TopicRow) => (
                <Text
                    mono
                    small
                    muted={r.hz === 0}
                    style={r.hz > 0 ? { color: heatColor(heatFracLog(r.bytesPerSec, maxBps)) } : undefined}
                >
                    {r.hz > 0 ? humanBits(r.bytesPerSec) : "—"}
                </Text>
            ),
        },
    ]
    return (
        <Panel
            glass
            collapsible
            persistKey="constellation.topics"
            title="Topics · Rate"
            actions={<Badge>{rows.length}</Badge>}
            id="topics"
            style={{ width: 300, minHeight: 0, flex: "0 1 auto" }}
        >
            <Row gap={6} style={{ padding: 8 }}>
                <SearchInput
                    value={filter}
                    onChange={setFilter}
                    placeholder="filter topics"
                    aria-label="filter topics"
                    style={{ flex: 1, minWidth: 0 }}
                />
                <Select
                    size="sm"
                    value={settings.transport}
                    onChange={(transport: Settings["transport"]) => change({ transport })}
                    options={[["all", "all"], ["lcm", "Multicast"], ["zenoh", "Zenoh"]]}
                    aria-label="transport"
                    style={{ flex: "none", width: 112 }}
                />
            </Row>
            <Table
                compact
                columns={columns}
                rows={rows}
                rowKey={(r: TopicRow) => `${r.transport} ${r.topic}`}
                sortRows={false}
                sort={{ key: settings.sort, dir: SORT_DIR[settings.sort] ?? "desc" }}
                onSortChange={(next: { key: Settings["sort"] } | null) => next && change({ sort: next.key })}
                maxHeight="calc(100vh - 340px)"
                empty={settings.filter
                    ? "no topics match the filter"
                    : "no topics yet: they appear a few seconds after a blueprint starts"}
            />
        </Panel>
    )
}

type WorkerRow = {
    role: string
    alive: boolean
    cpu: number
    mem: number
    raw: WorkerStats
}

function WorkersPanel({ workers }: { workers: WorkersView | null }) {
    const rows: WorkerRow[] = []
    const data = workers?.data
    if (data) {
        const add = (role: string, x: WorkerStats, alive: boolean) =>
            rows.push({
                role,
                alive,
                cpu: x.cpu_percent || 0,
                mem: x.pss || 0,
                raw: x,
            })
        if (data.coordinator) {
            add("coordinator", data.coordinator, true)
        }
        for (const w of data.workers || []) {
            const mods = Array.isArray(w.modules) ? w.modules.filter(Boolean) : []
            add(
                mods.length ? mods.join(", ") : `worker ${w.worker_id ?? "?"}`,
                w,
                w.alive !== false,
            )
        }
    }
    const maxMem = Math.max(0, ...rows.map((r) => r.mem))
    const live = !!workers?.live
    const columns = [
        {
            key: "role",
            label: "Worker",
            render: (r: WorkerRow) => (
                <Tooltip
                    content={<WorkerDetails row={r} />}
                    placement="left"
                    delay={150}
                >
                    <Text small muted={!r.alive}>{r.role}</Text>
                </Tooltip>
            ),
        },
        {
            key: "cpu",
            label: "CPU",
            align: "right",
            render: (r: WorkerRow) => (
                <Text mono small style={{ color: heatColor(Math.min(1, r.cpu / 100)) }}>
                    {r.cpu.toFixed(0)}%
                </Text>
            ),
        },
        {
            key: "mem",
            label: "RAM",
            align: "right",
            render: (r: WorkerRow) => (
                <Text
                    mono
                    small
                    style={{ color: heatColor(heatFracLog(r.mem, maxMem)) }}
                >
                    {human(r.mem)}
                </Text>
            ),
        },
    ]
    return (
        <Panel
            glass
            collapsible
            persistKey="constellation.workers"
            title="Workers · CPU/RAM"
            id="dtop"
            actions={
                <Row gap={6}>
                    <StatusDot tone={live ? "info" : "off"} />
                    <Text small muted>{live ? "live" : "no stream"}</Text>
                </Row>
            }
            style={{ width: 280 }}
        >
            <Table
                compact
                columns={columns}
                rows={rows}
                rowKey="role"
                maxHeight="50vh"
                empty={
                    <Text small muted>
                        launch a blueprint with <Text mono>--dtop</Text>
                    </Text>
                }
            />
        </Panel>
    )
}

/** every field the worker reports, mirroring the `dimos dtop` TUI */
function WorkerDetails({ row }: { row: WorkerRow }) {
    const x = row.raw
    return (
        <div style={{ minWidth: 220 }}>
            <Row gap={8} justify="space-between">
                <Text muted={!row.alive}>{row.role}</Text>
                {x.alive === false && <Badge tone="warn">dead</Badge>}
                <Text mono small muted>pid {x.pid ?? "—"}</Text>
            </Row>
            {x.worker_id != null && (
                <Text small muted as="div">
                    worker {x.worker_id}
                    {x.dedicated ? " · dedicated" : ""}
                </Text>
            )}
            <KeyValue
                items={[
                    ["CPU", `${(x.cpu_percent ?? 0).toFixed(0)}%`],
                    ["PSS", human(x.pss ?? 0)],
                    ["Threads", x.num_threads ?? "—"],
                    ["Children", x.num_children ?? "—"],
                    ["FDs", x.num_fds ?? "—"],
                    ["User time", humanSecs(x.cpu_time_user)],
                    ["Sys time", humanSecs(x.cpu_time_system)],
                    ["IO wait", humanSecs(x.cpu_time_iowait)],
                    ["IO read", human(x.io_read_bytes ?? 0)],
                    ["IO write", human(x.io_write_bytes ?? 0)],
                ]}
            />
            {Array.isArray(x.children) && x.children.length > 0 && (
                <KeyValue
                    items={x.children.map((
                        c,
                    ) => [
                        `${c.name || "?"} ${c.pid ?? ""}`,
                        `${(c.cpu_percent ?? 0).toFixed(0)}%`,
                    ])}
                />
            )}
        </div>
    )
}

/** A launcher-style card for a module: docstring, typed streams with live rates, skills, RPCs. Hover shows it; a
 * click pins it (shared: api/settings pinnedModule). */
function ModuleCardView(
    { flow, id, pinned }: { flow: FlowGraph; id: string; pinned: boolean },
) {
    const card = useRef<HTMLDivElement>(null)
    const node = flow.nodes.get(id)
    const info = flow.moduleInfo.get(id)
    const [position, setPosition] = useState({ left: -1000, top: 0 })
    useLayoutEffect(() => {
        const r = flow.nodeRect(id)
        if (!r) {
            return
        }
        const cw = 320
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
            return <Text mono small tone="ok">{stat.hz.toFixed(1)}Hz</Text>
        }
        return stat?.lastAt ? <Text mono small muted>{agoText(Date.now() - stat.lastAt)}</Text> : null
    }
    const streams = (
        list: { name: string; type?: string; wire?: string }[],
        tone: "info" | "default",
    ) => list.length
        ? (
            <Row gap={4} wrap>
                {list.map((s) => (
                    <Badge tone={tone} key={s.name}>
                        <Text mono small>
                            {s.name}
                            {s.wire && ` ↦ ${s.wire}`}
                        </Text>
                        <Text mono small muted>: {(s.type || "?").split(".").pop()}</Text>
                        {rate(s)}
                    </Badge>
                ))}
            </Row>
        )
        : <Text small muted>none</Text>
    const methods = (
        list: { name: string; params?: { name: string }[]; return_type?: string }[],
    ) => list.map((f) => (
        <Text mono small as="div" key={f.name}>
            {f.name}({(f.params || []).map((p) => p.name).join(", ")})
            {f.return_type && <Text muted>{` → ${f.return_type}`}</Text>}
        </Text>
    ))
    const section = (label: string, body: React.ReactNode) => (
        <div style={{ marginTop: 8 }}>
            <Label>{label}</Label>
            {body}
        </div>
    )
    return (
        <div
            ref={card}
            id="card"
            style={{ position: "fixed", zIndex: 8, width: 320, ...position }}
        >
            <Card
                glass
                title={
                    <Row gap={8}>
                        <Badge tone="info">MOD</Badge>
                        {info?.label || node.label}
                    </Row>
                }
                actions={pinned ? <Icon name="pin" size={14} /> : null}
            >
                {!info ? <Text small muted>no blueprint metadata</Text> : (
                    <>
                        {info.doc && <Text small muted as="div">{info.doc}</Text>}
                        {section(
                            `Publishes ${info.outputs.length}`,
                            streams(info.outputs, "info"),
                        )}
                        {section(
                            `Subscribes ${info.inputs.length}`,
                            streams(info.inputs, "default"),
                        )}
                        {info.skills.length > 0 && section("Skills", methods(info.skills))}
                        {info.rpcs.length > 0 && section("RPCs", methods(info.rpcs))}
                    </>
                )}
            </Card>
        </div>
    )
}
