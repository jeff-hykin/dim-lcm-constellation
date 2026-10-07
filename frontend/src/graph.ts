// The module/topic graph: React-Flow-style DOM nodes + one SVG edge layer inside a pan/zoomed viewport (one CSS
// transform, so cards, edges and labels scale together and stay crisp). It's imperative on purpose: a force sim and
// 60 fps edge animation over hundreds of elements. React (App.tsx) owns the panels around it and feeds it the
// backend's graph, stats and packet events.
import { accentForType, accentVar, agoText, channelType, normBase, transportLabel } from "./format.ts"
import { iconSvg } from "./icons.tsx"
import type { Graph, ModuleCard, TopicRow } from "./types.ts"

export type Node = {
    id: string
    kind: "module" | "topic"
    label: string
    x: number
    y: number
    w: number
    h: number
    r: number
    vx: number
    vy: number
    fx: number
    fy: number
    placed: boolean
    fixed: boolean
    transport: string
    msgType: string
    accent: string
    el: HTMLDivElement | null
    active: number
    dynamic?: boolean
    baseKey?: string
    lastTraffic?: number
}
type Edge = {
    from: string
    to: string
    channel: string
    directed: boolean
    declared: string | null
    el: SVGPathElement | null
    lab: HTMLDivElement | null
    active: number
    spline?: { x: number; y: number }[] | null
}
export type TopicStat = { hz: number; bps: number; count: number; lastAt: number }

export const LAYOUTS = [
    { id: "hierarchy", label: "Hierarchy", engine: "dot" }, // layered L→R DAG (default)
    { id: "organic", label: "Organic", engine: "neato" }, // stress / spring model
    { id: "force", label: "Force", engine: null }, // live force-directed web
    { id: "radial", label: "Radial", engine: "twopi" }, // radial tree
    { id: "circular", label: "Circular", engine: "circo" }, // nodes on one big cycle
] as const
export type LayoutId = typeof LAYOUTS[number]["id"]

// force-directed layout: every node repels every other (Coulomb), each edge pulls its ends toward an ideal length
// (Hooke), a gentle pull keeps it centered. The sim cools to rest and re-warms on drags and topology growth.
const REPULSION = 62000
const SPRING_K = 0.045
const SPRING_GAP = 96
const CENTER_K = 0.012
const DAMPING = 0.86
const MAX_STEP = 34
const PT_PER_IN = 72 // graphviz sizes are inches; our world unit is 1pt = 1px
// channels seen live but absent from the blueprint get a floating "recent" node, swept after this long idle
const RECENT_TOPIC_MS = 30 * 60 * 1000
const ZOOM_SENSITIVITY = 0.0016

// graphviz (WASM) is its own chunk, loaded the first time a non-force layout runs
type Graphviz = Awaited<ReturnType<typeof import("@hpcc-js/wasm-graphviz").Graphviz.load>>
let graphvizPromise: Promise<Graphviz> | null = null
function loadGraphviz(): Promise<Graphviz> {
    if (!graphvizPromise) {
        graphvizPromise = import("@hpcc-js/wasm-graphviz").then((mod) => mod.Graphviz.load())
    }
    return graphvizPromise
}

export class FlowGraph {
    readonly flow: HTMLDivElement
    private viewport: HTMLDivElement
    private svg: SVGSVGElement
    nodes = new Map<string, Node>()
    edges: Edge[] = []
    private edgeIndex = new Map<string, Edge>()
    private routes = new Map<string, { pubs: Set<string>; subs: Set<string> }>()
    topicBase = new Map<string, string[]>() // normBase(name) → topic node ids
    moduleInfo = new Map<string, ModuleCard>() // module node id → blueprint card
    stats = new Map<string, TopicStat>() // topic node id → live stats
    private dirty = false
    private heat = 0
    private seedCount = 0
    private settledOnce = false
    layoutId: LayoutId = "hierarchy"
    private simFrozen = false
    private currentBlueprint = ""
    view = { x: 0, y: 0, k: 1 }
    paused = false
    private filter = ""
    hovered: Node | null = null
    /** nodes lit from outside (Desktop's module list), shown like a hover while nothing is hovered */
    private spot: string[] = []
    /** the nodes lit now: the hovered one, else the spotlight */
    private lit = new Set<string>()
    private panning: { sx: number; sy: number; ox: number; oy: number } | null = null
    private dragNode: { n: Node; sx: number; sy: number; ox: number; oy: number } | null = null
    private moved = false
    private frame = 0
    private cleanup: (() => void)[] = []

    constructor(
        container: HTMLElement,
        private callbacks: { onHover: (node: Node | null) => void; onClick: (node: Node) => void },
    ) {
        this.flow = document.createElement("div")
        this.flow.id = "flow"
        this.viewport = document.createElement("div")
        this.viewport.id = "viewport"
        this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
        this.svg.id = "edges"
        // markerUnits=strokeWidth: arrowheads scale with each edge's stroke, so they stay proportional at every zoom
        this.svg.innerHTML = `<defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" markerUnits="strokeWidth" orient="auto-start-reverse">
                <path d="M0 0.5 L10 5 L0 9.5 z" fill="context-stroke"/>
            </marker>
            <marker id="arrowmid" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" markerUnits="strokeWidth" orient="auto">
                <path d="M0 0.5 L10 5 L0 9.5 z" fill="context-stroke"/>
            </marker></defs>`
        this.viewport.appendChild(this.svg)
        this.flow.appendChild(this.viewport)
        container.appendChild(this.flow)

        const listen = <K extends keyof WindowEventMap>(
            target: EventTarget,
            type: K | string,
            fn: (e: never) => void,
            opts?: AddEventListenerOptions,
        ) => {
            target.addEventListener(type, fn as EventListener, opts)
            this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts))
        }
        listen(this.flow, "wheel", (ev: WheelEvent) => {
            ev.preventDefault()
            const factor = Math.min(1.2, Math.max(1 / 1.2, Math.exp(-ev.deltaY * ZOOM_SENSITIVITY)))
            this.zoomAt(ev.clientX, ev.clientY, factor)
        }, { passive: false })
        listen(this.flow, "mousedown", (ev: MouseEvent) => this.mouseDown(ev))
        listen(window, "mousemove", (ev: MouseEvent) => this.mouseMove(ev))
        listen(window, "mouseup", () => this.mouseUp())
        listen(window, "resize", () => this.applyView())
        this.applyView()
        const animate = () => {
            this.frame = requestAnimationFrame(animate)
            this.animate()
        }
        this.frame = requestAnimationFrame(animate)
    }

    destroy() {
        cancelAnimationFrame(this.frame)
        for (const fn of this.cleanup) {
            fn()
        }
        this.flow.remove()
    }

    // ── model ──
    private ensureNode(id: string, kind: Node["kind"], label: string, transport = ""): Node {
        let n = this.nodes.get(id)
        if (!n) {
            n = {
                id,
                kind,
                label,
                x: 0,
                y: 0,
                w: kind === "module" ? 160 : 120,
                h: kind === "module" ? 40 : 34,
                r: 0,
                vx: 0,
                vy: 0,
                fx: 0,
                fy: 0,
                placed: false,
                fixed: false,
                transport,
                msgType: channelType(id).msgType,
                accent: kind === "module" ? "--info" : accentVar(id),
                el: null,
                active: 0,
            }
            this.nodes.set(id, n)
            this.dirty = true
        } else if (transport && !n.transport) {
            n.transport = transport
        }
        return n
    }

    private addEdge(from: string, to: string, channel: string, directed: boolean, declared: string | null) {
        const key = from + "|" + to
        let e = this.edgeIndex.get(key)
        if (!e) {
            e = { from, to, channel, directed, declared, el: null, lab: null, active: 0 }
            this.edges.push(e)
            this.edgeIndex.set(key, e)
            this.dirty = true
        }
        return e
    }

    private resetGraph() {
        for (const n of this.nodes.values()) {
            n.el?.remove()
        }
        for (const e of this.edges) {
            e.el?.remove()
            e.lab?.remove()
        }
        this.nodes.clear()
        this.edges.length = 0
        this.edgeIndex.clear()
        this.routes.clear()
        this.topicBase.clear()
        this.moduleInfo.clear()
        this.stats.clear()
        this.seedCount = 0
        this.settledOnce = false
        this.heat = 0
    }

    /** The active blueprint: modules with typed in/out streams joined into topics by name. Each publisher gets its own
     * topic node; a subscriber fans in from every same-named one. */
    applyGraph(g: Graph) {
        if (g.blueprint !== this.currentBlueprint) {
            this.resetGraph()
            this.currentBlueprint = g.blueprint
        }
        for (const [mid, info] of Object.entries(g.modules || {})) {
            this.ensureNode("m:" + mid, "module", info.label || mid)
            this.moduleInfo.set("m:" + mid, info)
        }
        const pubsByTopic = new Map<string, { modId: string; type: string; declared: string | null }[]>()
        const subsByTopic = new Map<string, { modId: string; declared: string | null }[]>()
        for (const t of g.edges || []) {
            if (!t.topic || t.topic === "None") {
                continue
            }
            const modId = "m:" + t.module
            if (!this.nodes.has(modId)) {
                this.ensureNode(modId, "module", g.modules?.[t.module]?.label || t.module)
            }
            if (t.direction === "in") {
                push(subsByTopic, t.topic, { modId, declared: t.declared })
            } else {
                push(pubsByTopic, t.topic, { modId, type: t.type, declared: t.declared })
            }
        }
        for (const name of new Set([...pubsByTopic.keys(), ...subsByTopic.keys()])) {
            const pubs = pubsByTopic.get(name) || []
            const subs = subsByTopic.get(name) || []
            const instances = pubs.length ? pubs : [{ modId: null, type: "", declared: null }]
            instances.forEach((pub, i) => {
                const topicId = pubs.length ? `${name}#${pub.modId}#${i}` : name
                const hub = this.ensureNode(topicId, "topic", name)
                hub.msgType = (pub.type || "").split(".").pop()!
                hub.accent = accentForType(pub.type, name)
                const route = { pubs: new Set<string>(), subs: new Set<string>() }
                if (pub.modId) {
                    route.pubs.add(pub.modId)
                    this.addEdge(pub.modId, topicId, name, true, pub.declared)
                }
                for (const sub of subs) {
                    route.subs.add(sub.modId)
                    this.addEdge(topicId, sub.modId, name, true, sub.declared)
                }
                this.routes.set(topicId, route)
                push(this.topicBase, normBase(name), topicId)
            })
        }
        if (this.dirty) {
            this.buildDom()
            this.dirty = false
            this.applyGraphLayout()
            this.applyFocus()
        }
    }

    private ensureDynamicTopic(base: string, transport: string) {
        const nodeId = "dyn:" + base
        const hub = this.ensureNode(nodeId, "topic", base, transport)
        hub.dynamic = true
        hub.baseKey = base
        if (!this.routes.has(nodeId)) {
            this.routes.set(nodeId, { pubs: new Set(), subs: new Set() })
        }
        this.topicBase.set(base, [nodeId])
        return nodeId
    }

    private removeDynamicTopic(id: string) {
        const n = this.nodes.get(id)
        if (!n) {
            return
        }
        n.el?.remove()
        for (let i = this.edges.length - 1; i >= 0; i--) {
            const e = this.edges[i]
            if (e.from === id || e.to === id) {
                e.el?.remove()
                e.lab?.remove()
                this.edges.splice(i, 1)
                this.edgeIndex.delete(e.from + "|" + e.to)
            }
        }
        this.nodes.delete(id)
        this.routes.delete(id)
        this.stats.delete(id)
        if (n.baseKey) {
            this.topicBase.delete(n.baseKey)
        }
    }

    /** The backend's per-channel stats → each topic node's rate (channels with no blueprint node float as "recent"). */
    applyStats(rows: TopicRow[]) {
        const now = Date.now()
        const next = new Map<string, TopicStat>()
        for (const row of rows) {
            if (row.declaredOnly || !row.transport) {
                continue
            }
            if (row.lastSeenMsAgo !== null && row.lastSeenMsAgo > RECENT_TOPIC_MS && !this.topicBase.has(row.name)) {
                continue
            }
            const ids = this.topicBase.get(row.name) ?? [this.ensureDynamicTopic(row.name, row.transport)]
            const lastAt = now - (row.lastSeenMsAgo ?? Infinity)
            for (const id of ids) {
                const stat = next.get(id) ?? { hz: 0, bps: 0, count: 0, lastAt: 0 }
                stat.hz += row.hz
                stat.bps += row.bytesPerSec
                stat.count += row.messages
                stat.lastAt = Math.max(stat.lastAt, lastAt)
                next.set(id, stat)
                const node = this.nodes.get(id)
                if (node) {
                    node.lastTraffic = Math.max(node.lastTraffic ?? 0, lastAt)
                    if (!node.transport) {
                        node.transport = row.transport
                    }
                }
            }
        }
        this.stats = next
        for (const n of [...this.nodes.values()]) {
            if (n.dynamic && now - (n.lastTraffic || 0) > RECENT_TOPIC_MS) {
                this.removeDynamicTopic(n.id)
            }
        }
        if (this.dirty) {
            this.buildDom()
            this.dirty = false
            if (!this.simFrozen) {
                this.reheat(0.5)
            }
        }
        for (const t of this.nodes.values()) {
            if (t.kind !== "topic" || !t.el) {
                continue
            }
            t.el.classList.toggle("orphan", this.isOrphan(t.id))
            const s = next.get(t.id)
            const rateEl = t.el.querySelector(".rate")!
            if (s && s.hz > 0.05) {
                rateEl.innerHTML = `<b>${s.hz.toFixed(1)}</b> Hz`
            } else if (s && s.lastAt > 0) {
                rateEl.innerHTML = `<span class="ago">${agoText(now - s.lastAt)}</span>`
            } else {
                rateEl.innerHTML = ""
            }
        }
        this.refreshEdges()
    }

    /** One spy batch: light up the topics (and their edges) that just carried traffic. */
    pulse(events: [string, string, number, number][]) {
        if (this.paused) {
            return
        }
        for (const [, channel] of events) {
            for (const id of this.topicBase.get(normBase(channel)) ?? []) {
                const hub = this.nodes.get(id)
                if (hub) {
                    hub.active = 1
                    for (const e of this.edgesOf(hub)) {
                        e.active = 1
                    }
                }
            }
        }
    }

    /** Fade topics (and modules with none of them) that don't match the topic filter. */
    setFilter(text: string) {
        this.filter = text.toLowerCase()
        this.applyFilter()
    }

    private matches(n: Node): boolean {
        if (!this.filter) {
            return true
        }
        if (n.kind === "topic") {
            return n.label.toLowerCase().includes(this.filter) || n.msgType.toLowerCase().includes(this.filter)
        }
        return this.edgesOf(n).some((e) => {
            const other = this.nodes.get(e.from === n.id ? e.to : e.from)
            return !!other && this.matches(other)
        })
    }

    private applyFilter() {
        for (const n of this.nodes.values()) {
            n.el?.classList.toggle("filtered", !this.matches(n))
        }
    }

    counts() {
        let modules = 0
        let topics = 0
        for (const n of this.nodes.values()) {
            n.kind === "module" ? modules++ : topics++
        }
        return { modules, topics }
    }

    /** a stream's live rate, through the channel it rides (its remapped wire name) */
    streamRate(name: string): TopicStat | null {
        const found = (this.topicBase.get(normBase(name)) || []).map((id) => this.stats.get(id)).filter((s) => !!s)
        if (!found.length) {
            return null
        }
        return {
            hz: Math.max(...found.map((s) => s.hz)),
            bps: Math.max(...found.map((s) => s.bps)),
            count: Math.max(...found.map((s) => s.count)),
            lastAt: Math.max(...found.map((s) => s.lastAt)),
        }
    }

    nodeRect(id: string): DOMRect | null {
        return this.nodes.get(id)?.el?.getBoundingClientRect() ?? null
    }

    // ── layout ──
    private seed(n: Node) {
        if (n.placed) {
            return
        }
        const ang = this.seedCount * 2.399963 // golden angle → even spiral
        const rad = 30 + 26 * Math.sqrt(this.seedCount + 1)
        n.x = Math.cos(ang) * rad
        n.y = Math.sin(ang) * rad
        n.vx = 0
        n.vy = 0
        n.placed = true
        this.seedCount++
    }

    private reheat(amount = 1) {
        if (!this.simFrozen) {
            this.heat = Math.max(this.heat, amount)
        }
    }

    private stepForces() {
        const ns = [...this.nodes.values()]
        for (const n of ns) {
            n.fx = 0
            n.fy = 0
        }
        for (let i = 0; i < ns.length; i++) {
            const a = ns[i]
            for (let j = i + 1; j < ns.length; j++) {
                const b = ns[j]
                let dx = a.x - b.x
                let dy = a.y - b.y
                let d2 = dx * dx + dy * dy
                if (d2 < 1) {
                    dx = Math.random() - 0.5
                    dy = Math.random() - 0.5
                    d2 = dx * dx + dy * dy + 0.01
                }
                const dist = Math.sqrt(d2)
                const ux = dx / dist
                const uy = dy / dist
                let f = REPULSION / d2
                const minDist = a.r + b.r + 22
                if (dist < minDist) {
                    f += (minDist - dist) * 1.1 // firm push out of overlap
                }
                a.fx += ux * f
                a.fy += uy * f
                b.fx -= ux * f
                b.fy -= uy * f
            }
        }
        for (const e of this.edges) {
            const a = this.nodes.get(e.from)
            const b = this.nodes.get(e.to)
            if (!a || !b) {
                continue
            }
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.hypot(dx, dy) || 1
            const f = SPRING_K * (dist - (SPRING_GAP + a.r + b.r))
            const ux = dx / dist
            const uy = dy / dist
            a.fx += ux * f
            a.fy += uy * f
            b.fx -= ux * f
            b.fy -= uy * f
        }
        for (const n of ns) {
            if (n.fixed) {
                n.vx = 0
                n.vy = 0
                continue
            }
            n.fx += -n.x * CENTER_K
            n.fy += -n.y * CENTER_K
            n.vx = (n.vx + n.fx) * DAMPING
            n.vy = (n.vy + n.fy) * DAMPING
            let sx = n.vx * this.heat
            let sy = n.vy * this.heat
            const step = Math.hypot(sx, sy)
            if (step > MAX_STEP) {
                sx = sx / step * MAX_STEP
                sy = sy / step * MAX_STEP
            }
            n.x += sx
            n.y += sy
        }
    }

    /** DOT from the live graph: each box carries its measured size so graphviz reserves exactly our footprint. */
    private buildDot(engine: string) {
        const arr = [...this.nodes.values()]
        const idx = new Map(arr.map((n, i) => [n.id, i]))
        const lines = ["digraph {"]
        lines.push(
            engine === "dot"
                ? "  graph [rankdir=LR, nodesep=0.45, ranksep=1.1, splines=true];"
                : '  graph [overlap=false, sep="+20", splines=true];',
        )
        lines.push("  node [fixedsize=true, shape=box];")
        if (engine === "dot") {
            // left to right: edges leave a box on its right side and arrive on the left one
            lines.push("  edge [tailport=e, headport=w];")
        }
        arr.forEach((n, i) =>
            lines.push(`  n${i} [width=${(n.w / PT_PER_IN).toFixed(3)}, height=${(n.h / PT_PER_IN).toFixed(3)}];`)
        )
        const emitted: Edge[] = []
        for (const e of this.edges) {
            const a = idx.get(e.from)
            const b = idx.get(e.to)
            if (a == null || b == null) {
                continue
            }
            lines.push(`  n${a} -> n${b};`)
            emitted.push(e)
        }
        lines.push("}")
        return { dot: lines.join("\n"), arr, emitted }
    }

    /** graphviz points (y up) → our pixels (y down, centered); node centers and each edge's bspline. */
    // deno-lint-ignore no-explicit-any
    private applyEnginePositions(json: any, arr: Node[], emitted: Edge[]) {
        const bb = (json.bb || "0,0,0,0").split(",").map(Number)
        const boxH = bb[3]
        const cx = bb[2] / 2
        const cy = bb[3] / 2
        const toWorld = (x: number, y: number) => ({ x: x - cx, y: (boxH - y) - cy })
        const objects: { _gvid: number; name: string; pos?: string }[] = json.objects || []
        const gvidName = new Map(objects.map((o) => [o._gvid, o.name]))
        for (const o of objects) {
            const m = /^n(\d+)$/.exec(o.name || "")
            if (!m || !o.pos) {
                continue
            }
            const [px, py] = o.pos.split(",").map(Number)
            const p = toWorld(px, py)
            const n = arr[+m[1]]
            n.x = p.x
            n.y = p.y
            n.vx = 0
            n.vy = 0
            n.fixed = true
        }
        for (const e of this.edges) {
            e.spline = null
        }
        const byPair = new Map<string, Edge[]>()
        for (const e of emitted) {
            push(byPair, `n${arr.indexOf(this.nodes.get(e.from)!)}>n${arr.indexOf(this.nodes.get(e.to)!)}`, e)
        }
        for (const ge of json.edges || []) {
            const e = byPair.get(`${gvidName.get(ge.tail)}>${gvidName.get(ge.head)}`)?.shift()
            if (!e) {
                continue
            }
            const draw = (ge._draw_ || []).find((d: { op: string }) => d.op === "b" || d.op === "B")
            if (draw && Array.isArray(draw.points)) {
                e.spline = draw.points.map(([x, y]: [number, number]) => toWorld(x, y))
            }
        }
    }

    private layoutSpiral() {
        let i = 0
        for (const n of this.nodes.values()) {
            const ang = i * 2.399963
            const rad = 30 + 26 * Math.sqrt(i + 1)
            n.x = Math.cos(ang) * rad
            n.y = Math.sin(ang) * rad
            i++
        }
    }

    /** settle the force sim synchronously (so nodes don't visibly fly), then frame it */
    private relaxAndFrame() {
        for (const n of this.nodes.values()) {
            n.vx = 0
            n.vy = 0
        }
        this.heat = 1
        for (let i = 0; i < 320; i++) {
            this.stepForces()
        }
        this.heat = 0.1
        this.positionAll()
        this.fitView()
    }

    private applyGraphLayout() {
        if (!this.settledOnce && this.nodes.size) {
            this.settledOnce = true
            this.setLayout(this.layoutId)
        } else if (this.simFrozen) {
            this.setLayout(this.layoutId)
        } else {
            this.reheat(1)
        }
    }

    /** Force = seed a spiral and relax the sim; a graphviz engine = compute its layout and freeze the sim. */
    async setLayout(id: LayoutId) {
        const layout = LAYOUTS.find((l) => l.id === id)
        if (!layout) {
            return
        }
        this.layoutId = id
        for (const n of this.nodes.values()) {
            n.fixed = false
        }
        if (!layout.engine) {
            this.simFrozen = false
            for (const e of this.edges) {
                e.spline = null
            }
            this.layoutSpiral()
            this.relaxAndFrame()
            return
        }
        try {
            const gv = await loadGraphviz()
            const { dot, arr, emitted } = this.buildDot(layout.engine)
            this.applyEnginePositions(JSON.parse(gv.layout(dot, "json", layout.engine as "dot")), arr, emitted)
            this.simFrozen = true
            this.heat = 0
            this.positionAll()
            this.fitView()
        } catch (error) {
            console.error(`layout ${id} failed:`, error)
            this.simFrozen = false
            this.layoutSpiral()
            this.relaxAndFrame()
        }
    }

    // ── DOM ──
    private isOrphan(topicId: string) {
        const r = this.routes.get(topicId)
        return !!(r && r.pubs.size > 0 && r.subs.size === 0)
    }

    private buildDom() {
        for (const n of this.nodes.values()) {
            if (n.el) {
                continue
            }
            const el = document.createElement("div")
            el.className = "node " + n.kind
            el.style.setProperty("--node-accent", `var(${n.accent})`)
            el.dataset.id = n.id
            if (n.kind === "module") {
                el.innerHTML =
                    `<div class="head"><span class="kind">MOD</span><span class="name"></span><span class="chev">${
                        iconSvg("chevron-right")
                    }</span></div><div class="body"></div><span class="handle l"></span><span class="handle r"></span>`
                el.querySelector(".name")!.textContent = n.label
            } else {
                if (this.isOrphan(n.id)) {
                    el.classList.add("orphan")
                }
                if (n.dynamic) {
                    el.classList.add("recent")
                }
                el.innerHTML =
                    `<span class="name"></span><span class="rate"></span><span class="type"></span><span class="handle l"></span><span class="handle r"></span>`
                el.querySelector(".name")!.textContent = n.label
                el.querySelector(".type")!.textContent = n.msgType || transportLabel(n.transport).toUpperCase() || ""
            }
            this.viewport.appendChild(el)
            n.el = el
            n.w = el.offsetWidth
            n.h = el.offsetHeight
            n.r = 0.5 * Math.hypot(n.w, n.h)
            this.seed(n)
        }
        for (const e of this.edges) {
            if (e.el) {
                continue
            }
            const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
            p.setAttribute("stroke", "var(--border)")
            p.setAttribute("stroke-width", "1.5")
            if (e.directed) {
                p.setAttribute("marker-mid", "url(#arrowmid)")
                p.setAttribute("marker-end", "url(#arrow)")
            }
            this.svg.appendChild(p)
            e.el = p
            if (e.declared) {
                // a blueprint rename reads along the flow: `twist_command ↦` leaving a module, `↦ twist_command` arriving
                const lab = document.createElement("div")
                lab.className = "elabel"
                lab.textContent = this.nodes.get(e.from)?.kind === "module" ? `${e.declared} ↦` : `↦ ${e.declared}`
                this.viewport.appendChild(lab)
                e.lab = lab
            }
        }
        this.positionAll()
        this.applyFilter()
    }

    private hubOf(e: Edge) {
        const a = this.nodes.get(e.from)!
        return a.kind === "topic" ? a : this.nodes.get(e.to)!
    }

    /** a dead-end edge (its topic lacks a publisher or a subscriber) draws thin; a pass-through draws thick */
    private edgeIsTerminal(e: Edge) {
        const r = this.routes.get(this.hubOf(e).id)
        return !!(r && (r.pubs.size === 0 || r.subs.size === 0))
    }

    private borderPoint(n: Node, ux: number, uy: number) {
        const hw = n.w / 2 + 2
        const hh = n.h / 2 + 2
        const tx = Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity
        const ty = Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity
        const t = Math.min(tx, ty)
        return { x: n.x + ux * t, y: n.y + uy * t }
    }

    /** border-to-border with a slight bow, split at the middle so marker-mid sits on the curve */
    private edgeGeom(e: Edge) {
        const a = this.nodes.get(e.from)!
        const b = this.nodes.get(e.to)!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const ux = dx / dist
        const uy = dy / dist
        const pa = this.borderPoint(a, ux, uy)
        const pb = this.borderPoint(b, -ux, -uy)
        const mx = (pa.x + pb.x) / 2
        const my = (pa.y + pb.y) / 2
        const bow = Math.min(26, dist * 0.13)
        const cx = mx - uy * bow
        const cy = my + ux * bow
        const q0x = (pa.x + cx) / 2
        const q0y = (pa.y + cy) / 2
        const q1x = (cx + pb.x) / 2
        const q1y = (cy + pb.y) / 2
        const midx = (q0x + q1x) / 2
        const midy = (q0y + q1y) / 2
        const f = (v: number) => v.toFixed(1)
        return {
            d: `M ${f(pa.x)} ${f(pa.y)} Q ${f(q0x)} ${f(q0y)} ${f(midx)} ${f(midy)} Q ${f(q1x)} ${f(q1y)} ${f(pb.x)} ${
                f(pb.y)
            }`,
            mid: { x: midx, y: midy },
        }
    }

    private positionNode(n: Node) {
        if (n.el) {
            n.el.style.left = (n.x - n.w / 2) + "px"
            n.el.style.top = (n.y - n.h / 2) + "px"
        }
    }

    edgePath(e: Edge): { d: string; mid: { x: number; y: number } } {
        if (this.simFrozen && e.spline && e.spline.length >= 4) {
            const pts = e.spline
            let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
            for (let i = 1; i + 2 < pts.length; i += 3) {
                d += ` C ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${pts[i + 1].x.toFixed(1)} ${
                    pts[i + 1].y.toFixed(1)
                } ${pts[i + 2].x.toFixed(1)} ${pts[i + 2].y.toFixed(1)}`
            }
            return { d, mid: pts[Math.floor(pts.length / 2)] }
        }
        return this.edgeGeom(e)
    }

    private positionEdge(e: Edge) {
        if (!e.el) {
            return
        }
        const { d, mid } = this.edgePath(e)
        e.el.setAttribute("d", d)
        if (e.lab) {
            e.lab.style.left = mid.x.toFixed(1) + "px"
            e.lab.style.top = mid.y.toFixed(1) + "px"
        }
    }

    private positionAll() {
        for (const n of this.nodes.values()) {
            this.positionNode(n)
        }
        for (const e of this.edges) {
            this.positionEdge(e)
        }
        this.sizeSvg()
    }

    edgesOf(n: Node) {
        return this.edges.filter((e) => e.from === n.id || e.to === n.id)
    }

    private sizeSvg() {
        let minX = 0
        let minY = 0
        let maxX = 0
        let maxY = 0
        for (const n of this.nodes.values()) {
            minX = Math.min(minX, n.x - n.w)
            minY = Math.min(minY, n.y - n.h)
            maxX = Math.max(maxX, n.x + n.w)
            maxY = Math.max(maxY, n.y + n.h)
        }
        const w = Math.max(1, maxX - minX)
        const h = Math.max(1, maxY - minY)
        this.svg.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`)
        this.svg.setAttribute("width", String(w))
        this.svg.setAttribute("height", String(h))
        this.svg.style.left = minX + "px"
        this.svg.style.top = minY + "px"
    }

    // ── pan / zoom ──
    private applyView() {
        const { x, y, k } = this.view
        this.viewport.style.transform = `translate(${x}px, ${y}px) scale(${k})`
        const s = 22 * k
        this.flow.style.backgroundSize = `${s}px ${s}px`
        this.flow.style.backgroundPosition = `${x}px ${y}px`
    }

    fitView() {
        if (!this.nodes.size) {
            return
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const n of this.nodes.values()) {
            minX = Math.min(minX, n.x - n.w / 2)
            minY = Math.min(minY, n.y - n.h / 2)
            maxX = Math.max(maxX, n.x + n.w / 2)
            maxY = Math.max(maxY, n.y + n.h / 2)
        }
        const pad = 80
        const w = maxX - minX + pad * 2
        const h = maxY - minY + pad * 2
        this.view.k = Math.max(0.2, Math.min(1.4, Math.min(innerWidth / w, innerHeight / h)))
        this.view.x = (innerWidth - (minX + maxX) * this.view.k) / 2
        this.view.y = (innerHeight - (minY + maxY) * this.view.k) / 2
        this.applyView()
    }

    zoomAt(sx: number, sy: number, factor: number) {
        const k2 = Math.max(0.2, Math.min(2.5, this.view.k * factor))
        const wx = (sx - this.view.x) / this.view.k
        const wy = (sy - this.view.y) / this.view.k
        this.view.k = k2
        this.view.x = sx - wx * k2
        this.view.y = sy - wy * k2
        this.applyView()
    }

    // ── drag: pan & nodes; hover ──
    private nodeAt(target: EventTarget | null): Node | null {
        const el = (target as Element | null)?.closest?.(".node") as HTMLElement | null
        return el ? this.nodes.get(el.dataset.id!) ?? null : null
    }

    private mouseDown(ev: MouseEvent) {
        const n = this.nodeAt(ev.target)
        this.moved = false
        if (n) {
            this.dragNode = { n, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y }
            n.fixed = true
            this.reheat(0.7)
        } else {
            this.panning = { sx: ev.clientX, sy: ev.clientY, ox: this.view.x, oy: this.view.y }
            this.flow.classList.add("grabbing")
        }
    }

    private mouseMove(ev: MouseEvent) {
        if (this.dragNode) {
            const dx = ev.clientX - this.dragNode.sx
            const dy = ev.clientY - this.dragNode.sy
            if (Math.abs(dx) + Math.abs(dy) > 3) {
                this.moved = true
            }
            this.dragNode.n.x = this.dragNode.ox + dx / this.view.k
            this.dragNode.n.y = this.dragNode.oy + dy / this.view.k
            this.reheat(0.5)
            this.positionNode(this.dragNode.n)
            // a dragged node's graphviz splines no longer fit; fall back to live geometry
            for (const e of this.edgesOf(this.dragNode.n)) {
                e.spline = null
                this.positionEdge(e)
            }
            this.sizeSvg()
            return
        }
        if (this.panning) {
            if (Math.abs(ev.clientX - this.panning.sx) + Math.abs(ev.clientY - this.panning.sy) > 3) {
                this.moved = true
            }
            this.view.x = this.panning.ox + (ev.clientX - this.panning.sx)
            this.view.y = this.panning.oy + (ev.clientY - this.panning.sy)
            this.applyView()
            return
        }
        // over the module card: keep its module hovered
        if ((ev.target as Element | null)?.closest?.("#card")) {
            return
        }
        this.setHover(this.nodeAt(ev.target))
    }

    private mouseUp() {
        if (this.dragNode) {
            this.dragNode.n.fixed = false
            this.reheat(0.6)
            if (!this.moved) {
                this.callbacks.onClick(this.dragNode.n)
            }
            this.dragNode = null
        }
        this.panning = null
        this.flow.classList.remove("grabbing")
    }

    setHover(n: Node | null) {
        if (n === this.hovered) {
            return
        }
        this.hovered = n
        this.applyFocus()
        this.callbacks.onHover(n)
    }

    /** Light a module (`m:<name>`) or a topic (its name: every node on it) and their neighbours, as a hover does;
     * null clears it. */
    spotlight(target: { module?: string; topic?: string } | null) {
        this.spot = target?.module
            ? ["m:" + target.module]
            : target?.topic
            ? this.topicBase.get(normBase(target.topic)) ?? []
            : []
        this.applyFocus()
    }

    private applyFocus() {
        const lit = this.hovered ? [this.hovered] : this.spot.map((id) => this.nodes.get(id)).filter((n) => !!n)
        this.lit = new Set(lit.map((n) => n.id))
        const focus = new Set<string>(this.lit)
        for (const n of lit) {
            for (const e of this.edgesOf(n)) {
                focus.add(e.from)
                focus.add(e.to)
            }
        }
        for (const node of this.nodes.values()) {
            node.el?.classList.toggle("dim", lit.length > 0 && !focus.has(node.id))
            node.el?.classList.toggle("hi", this.lit.has(node.id))
        }
        this.refreshEdges()
    }

    // ── animation ──
    private refreshEdges() {
        const rest = "color-mix(in srgb, var(--muted-fg) 55%, transparent)"
        for (const e of this.edges) {
            if (!e.el) {
                continue
            }
            const on = this.lit.has(e.from) || this.lit.has(e.to)
            const lit = e.active > 0.05
            const hot = on || lit
            const accent = `var(${this.hubOf(e).accent})`
            const base = this.edgeIsTerminal(e) ? 1.1 : 2.4
            e.el.style.color = hot ? accent : rest
            e.el.style.stroke = hot ? accent : rest
            e.el.style.strokeWidth = (on ? base + 1.1 : lit ? base + 0.6 : base).toFixed(1)
            e.el.style.strokeDasharray = lit ? "5 6" : "none"
            if (e.lab) {
                e.lab.style.color = hot ? accent : "var(--muted-fg)"
                e.lab.style.borderColor = hot ? accent : rest
            }
        }
    }

    private animate() {
        if (!this.paused && !this.simFrozen && this.heat > 0.04) {
            this.stepForces()
            this.heat *= 0.985
            if (this.heat < 0.04) {
                this.heat = 0
            }
            this.positionAll()
        }
        let any = false
        for (const e of this.edges) {
            if (!this.paused && e.active > 0.001) {
                e.active *= 0.95
                any = true
            }
        }
        for (const n of this.nodes.values()) {
            if (!this.paused && n.active > 0.001) {
                n.active *= 0.95
            }
            n.el?.classList.toggle("pulse", n.active > 0.3)
        }
        if (any) {
            const off = (performance.now() * -0.03) % 11
            for (const e of this.edges) {
                if (e.active > 0.05 && e.el) {
                    e.el.style.strokeDashoffset = off.toFixed(1)
                }
            }
            this.refreshEdges()
        }
    }

    /** The graph as the user sees it (pan, zoom, colors), drawn to a PNG for the agent's screenshot. */
    renderPng(header: string): string {
        const ratio = Math.min(2, devicePixelRatio || 1)
        const canvas = document.createElement("canvas")
        canvas.width = innerWidth * ratio
        canvas.height = innerHeight * ratio
        const ctx = canvas.getContext("2d")!
        const style = getComputedStyle(document.body)
        const color = (name: string) => style.getPropertyValue(name).trim() || "#888"
        ctx.scale(ratio, ratio)
        ctx.fillStyle = color("--bg")
        ctx.fillRect(0, 0, innerWidth, innerHeight)
        ctx.save()
        ctx.translate(this.view.x, this.view.y)
        ctx.scale(this.view.k, this.view.k)
        for (const e of this.edges) {
            const hub = this.hubOf(e)
            ctx.strokeStyle = e.active > 0.05 ? color(hub.accent) : color("--muted-fg")
            ctx.globalAlpha = e.active > 0.05 ? 1 : 0.55
            ctx.lineWidth = this.edgeIsTerminal(e) ? 1.1 : 2.4
            ctx.stroke(new Path2D(this.edgePath(e).d))
        }
        ctx.globalAlpha = 1
        for (const n of this.nodes.values()) {
            const faded = this.filter && !this.matches(n)
            ctx.globalAlpha = faded ? 0.26 : 1
            const x = n.x - n.w / 2
            const y = n.y - n.h / 2
            ctx.beginPath()
            ctx.roundRect(x, y, n.w, n.h, n.kind === "module" ? 10 : n.h / 2)
            ctx.fillStyle = color("--card")
            ctx.fill()
            ctx.lineWidth = 1.5
            ctx.strokeStyle = color(n.accent)
            ctx.stroke()
            ctx.fillStyle = color("--fg")
            ctx.font = `600 ${n.kind === "module" ? 13 : 11}px ${style.getPropertyValue("--mono") || "monospace"}`
            ctx.textBaseline = "middle"
            const s = this.stats.get(n.id)
            if (n.kind === "module") {
                ctx.fillText(n.label, x + 15, n.y, n.w - 20)
            } else {
                ctx.fillText(n.label, x + 11, s ? n.y - 5 : n.y, n.w - 16)
                if (s) {
                    ctx.font = `9px ${style.getPropertyValue("--mono") || "monospace"}`
                    ctx.fillStyle = color("--muted-fg")
                    ctx.fillText(
                        s.hz > 0.05 ? `${s.hz.toFixed(1)} Hz` : agoText(Date.now() - s.lastAt),
                        x + 11,
                        n.y + 8,
                    )
                }
            }
        }
        ctx.restore()
        ctx.globalAlpha = 1
        ctx.fillStyle = color("--muted-fg")
        ctx.font = `12px ${style.getPropertyValue("--sans") || "sans-serif"}`
        ctx.textBaseline = "top"
        ctx.fillText(header, 14, 14)
        return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "")
    }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key)
    if (list) {
        list.push(value)
    } else {
        map.set(key, [value])
    }
}
