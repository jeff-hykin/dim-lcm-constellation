// What the app knows: the running blueprint's module graph (from Desktop), every LCM/Zenoh channel the spy has seen
// with its rate and sizes, the dtop worker table, and the shared view settings. routes.ts exposes it; main.ts feeds it.
import { HttpError, openPages, publishEvent, publishFrontend } from "./http.ts"
import { unpickle } from "./pickle.ts"

export const WINDOW_MS = 5000
const HISTORY_SECONDS = 60
const SAMPLE_PREVIEW_BYTES = 256

export type Stream = { name: string; type?: string; wire?: string }
export type ModuleCard = {
    id: string
    label: string
    doc: string
    inputs: Stream[]
    outputs: Stream[]
    rpcs: unknown[]
    skills: unknown[]
}
export type GraphEdge = {
    module: string
    topic: string
    type: string
    direction: "in" | "out"
    declared: string | null
}
export type Graph = { blueprint: string; unknown?: boolean; modules: Record<string, ModuleCard>; edges: GraphEdge[] }

export const LAYOUTS = ["hierarchy", "organic", "force", "radial", "circular"] as const
export type Settings = {
    layout: typeof LAYOUTS[number]
    sort: "bps" | "hz" | "name" | "messages"
    filter: string
    transport: "all" | "lcm" | "zenoh"
    showTopics: boolean
    showWorkers: boolean
    pinnedModule: string | null
}

type Channel = {
    transport: string
    channel: string
    messages: number
    totalBytes: number
    lastAt: number
    window: [number, number, number][] // [ms, count, bytes]
    history: Map<number, [number, number]> // second → [count, bytes]
}

export type TopicRow = {
    topic: string
    transport: string | null
    name: string
    msgType: string
    hz: number
    bytesPerSec: number
    avgMessageBytes: number
    messages: number
    totalBytes: number
    lastSeenMsAgo: number | null
    publishers: string[]
    subscribers: string[]
    declaredOnly?: boolean
}

export type Sample = { topic: string; transport: string; size: number; bytes: Uint8Array }

/** A channel's display name and message type: LCM puts the type after `#` (`/odom#nav_msgs.Odometry`), Zenoh as the
 * last key segment (`dimos/cmd_vel/geometry_msgs.Twist`). */
export function channelType(channel: string): { base: string; msgType: string } {
    if (channel.includes("#")) {
        const [base, msgType] = channel.split("#")
        return { base, msgType: msgType ?? "" }
    }
    const segments = channel.split("/")
    const last = segments[segments.length - 1]
    if (segments.length > 1 && last.includes(".")) {
        return { base: segments.slice(0, -1).join("/"), msgType: last }
    }
    return { base: channel, msgType: "" }
}

/** The bare name a channel and a blueprint stream share (`/camera_info#sensor_msgs.CameraInfo` → `camera_info`). */
export function normBase(channel: string): string {
    const segments = channelType(channel).base.replace(/^\/+/, "").split("/")
    return segments[segments.length - 1]
}

/** A blueprint's modules and their in/out streams (Desktop's /dimos/blueprints/<name>) as a module↔topic graph. */
export function buildGraph(name: string, info: { modules?: unknown[] }): Graph {
    const modules: Record<string, ModuleCard> = {}
    const edges: GraphEdge[] = []
    const seen = new Set<string>()
    for (const raw of info.modules ?? []) {
        const module = raw as {
            name: string
            class?: string
            doc?: string
            streams?: { name: string; type?: string; direction?: string }[]
        }
        const streams = module.streams ?? []
        const pick = (direction: string) =>
            streams.filter((s) => s.direction === direction || s.direction === "inout").map(({ name, type }) => ({
                name,
                type,
            }))
        modules[module.name] = {
            id: module.name,
            label: String(module.class ?? module.name).split(".").pop()!,
            doc: module.doc ?? "",
            inputs: pick("in"),
            outputs: pick("out"),
            rpcs: [],
            skills: [],
        }
        for (
            const [direction, list] of [["out", modules[module.name].outputs], [
                "in",
                modules[module.name].inputs,
            ]] as const
        ) {
            for (const stream of list) {
                const key = `${module.name}|${stream.name}|${direction}`
                if (!seen.has(key)) {
                    seen.add(key)
                    edges.push({
                        module: module.name,
                        topic: stream.name,
                        type: stream.type ?? "",
                        direction,
                        declared: null,
                    })
                }
            }
        }
    }
    return { blueprint: name, modules, edges }
}

export class Monitor {
    desktopUrl: string
    graph: Graph = { blueprint: "", modules: {}, edges: [] }
    channels = new Map<string, Channel>()
    workers: { data: unknown; at: number } | null = null
    paused = false
    pausedAt = 0
    settings: Settings = {
        layout: "hierarchy",
        sort: "bps",
        filter: "",
        transport: "all",
        showTopics: true,
        showWorkers: true,
        pinnedModule: null,
    }
    spy = { path: null as string | null, running: false, restarts: 0, lastError: null as string | null }
    /** writes a line to the spy's stdin (main.ts sets it once the spy runs) */
    spyInput: ((line: string) => void) | null = null
    private sampleWaiters = new Map<string, ((sample: Sample) => void)[]>()

    constructor(desktopUrl: string) {
        this.desktopUrl = desktopUrl
    }

    /** "now" for rates: frozen while paused, so a paused snapshot keeps its numbers */
    now(): number {
        return this.paused ? this.pausedAt : Date.now()
    }

    /** One NDJSON frame from the spy. */
    ingest(frame: Record<string, unknown>, at = Date.now()) {
        if (frame.kind === "sample") {
            this.resolveSample(frame)
            return
        }
        if (this.paused) {
            return
        }
        if (frame.kind === "packets" && Array.isArray(frame.events)) {
            for (const [transport, channel, count, bytes] of frame.events as [string, string, number, number][]) {
                this.note(transport, channel, count, bytes, at)
            }
            if (openPages()) {
                // the edges' pulses: frontend topic `packets`, latest-wins, so unordered
                publishFrontend("packets", { type: "packets", events: frame.events }, { ordered: false })
            }
        } else if (frame.kind === "raw" && String(frame.channel).includes("resource_stats")) {
            try {
                const data = unpickle(Uint8Array.from(atob(String(frame.b64)), (c) => c.charCodeAt(0)))
                if (data && typeof data === "object") {
                    this.workers = { data, at }
                    publishEvent({ type: "workers", ...this.workersView() })
                }
            } catch {
                // not a payload we can read: keep the last table
            }
        }
    }

    note(transport: string, channel: string, count: number, bytes: number, at = Date.now()) {
        const key = `${transport} ${channel}`
        let entry = this.channels.get(key)
        if (!entry) {
            entry = { transport, channel, messages: 0, totalBytes: 0, lastAt: 0, window: [], history: new Map() }
            this.channels.set(key, entry)
        }
        entry.messages += count
        entry.totalBytes += bytes
        entry.lastAt = at
        entry.window.push([at, count, bytes])
        const second = Math.floor(at / 1000)
        const bucket = entry.history.get(second) ?? [0, 0]
        entry.history.set(second, [bucket[0] + count, bucket[1] + bytes])
    }

    private roll(entry: Channel, now: number) {
        if (this.paused) {
            return
        }
        while (entry.window.length && now - entry.window[0][0] > WINDOW_MS) {
            entry.window.shift()
        }
        const oldest = Math.floor(now / 1000) - HISTORY_SECONDS
        for (const second of entry.history.keys()) {
            if (second <= oldest) {
                entry.history.delete(second)
            }
        }
    }

    private routesFor(name: string) {
        const publishers = new Set<string>()
        const subscribers = new Set<string>()
        for (const edge of this.graph.edges) {
            if (normBase(edge.topic) === name) {
                ;(edge.direction === "out" ? publishers : subscribers).add(edge.module)
            }
        }
        return { publishers: [...publishers], subscribers: [...subscribers] }
    }

    private row(entry: Channel, now: number): TopicRow {
        this.roll(entry, now)
        let count = 0
        let bytes = 0
        for (const [, c, b] of entry.window) {
            count += c
            bytes += b
        }
        const name = normBase(entry.channel)
        return {
            topic: entry.channel,
            transport: entry.transport,
            name,
            msgType: channelType(entry.channel).msgType,
            hz: round(count / (WINDOW_MS / 1000)),
            bytesPerSec: round(bytes / (WINDOW_MS / 1000)),
            avgMessageBytes: Math.round(count ? bytes / count : entry.messages ? entry.totalBytes / entry.messages : 0),
            messages: entry.messages,
            totalBytes: entry.totalBytes,
            lastSeenMsAgo: Math.max(0, now - entry.lastAt),
            ...this.routesFor(name),
        }
    }

    /** Every channel seen, plus blueprint topics nothing has been seen on (declaredOnly). */
    allTopics(): TopicRow[] {
        const now = this.now()
        const rows = [...this.channels.values()].map((entry) => this.row(entry, now))
        const seen = new Set(rows.map((row) => row.name))
        const typeOf = new Map<string, string>()
        for (const edge of this.graph.edges) {
            if (edge.type && !typeOf.has(normBase(edge.topic))) {
                typeOf.set(normBase(edge.topic), edge.type)
            }
        }
        for (const name of new Set(this.graph.edges.map((edge) => normBase(edge.topic)))) {
            if (!seen.has(name) && name && name !== "None") {
                rows.push({
                    topic: name,
                    transport: null,
                    name,
                    msgType: typeOf.get(name) ?? "",
                    hz: 0,
                    bytesPerSec: 0,
                    avgMessageBytes: 0,
                    messages: 0,
                    totalBytes: 0,
                    lastSeenMsAgo: null,
                    declaredOnly: true,
                    ...this.routesFor(name),
                })
            }
        }
        return rows
    }

    /** The topics table: filtered by text/transport, live ones first in the sort order, idle ones by recency. */
    listTopics(options: { filter?: string; transport?: string; active?: boolean; sort?: string; limit?: number } = {}) {
        const filter = (options.filter ?? "").toLowerCase()
        const transport = options.transport ?? "all"
        const sort = options.sort ?? "bps"
        let rows = this.allTopics().filter((row) =>
            (!filter || row.topic.toLowerCase().includes(filter) || row.msgType.toLowerCase().includes(filter)) &&
            (transport === "all" || row.transport === transport) &&
            (!options.active || row.hz > 0)
        )
        const live = (row: TopicRow) => row.hz > 0
        rows.sort((a, b) => {
            if (sort === "name") {
                return a.topic.localeCompare(b.topic)
            }
            if (live(a) !== live(b)) {
                return live(a) ? -1 : 1
            }
            if (!live(a)) {
                return (a.lastSeenMsAgo ?? Infinity) - (b.lastSeenMsAgo ?? Infinity) || a.topic.localeCompare(b.topic)
            }
            if (sort === "messages") {
                return b.messages - a.messages || a.topic.localeCompare(b.topic)
            }
            return sort === "hz"
                ? b.hz - a.hz || b.bytesPerSec - a.bytesPerSec || a.topic.localeCompare(b.topic)
                : b.bytesPerSec - a.bytesPerSec || b.hz - a.hz || a.topic.localeCompare(b.topic)
        })
        if (options.limit !== undefined) {
            rows = rows.slice(0, options.limit)
        }
        return rows
    }

    totals() {
        const rows = this.allTopics()
        return {
            hz: round(rows.reduce((sum, row) => sum + row.hz, 0)),
            bytesPerSec: round(rows.reduce((sum, row) => sum + row.bytesPerSec, 0)),
            channels: this.channels.size,
            liveChannels: rows.filter((row) => row.hz > 0).length,
        }
    }

    /** One topic: exact channel, else every channel with that bare name. */
    topicDetails(topic: string) {
        const now = this.now()
        const matches = [...this.channels.values()].filter((entry) => entry.channel === topic)
        const found = matches.length
            ? matches
            : [...this.channels.values()].filter((entry) => normBase(entry.channel) === normBase(topic))
        const declared = this.allTopics().find((row) => row.declaredOnly && row.name === normBase(topic))
        if (!found.length && !declared) {
            throw new HttpError(404, `no topic ${topic} (seen or in the blueprint); GET api/topics lists them`)
        }
        return {
            channels: found.map((entry) => {
                const row = this.row(entry, now)
                const first = Math.floor(now / 1000) - HISTORY_SECONDS + 1
                const history = []
                for (let second = first; second <= Math.floor(now / 1000); second++) {
                    const [count, bytes] = entry.history.get(second) ?? [0, 0]
                    history.push({ secondsAgo: Math.floor(now / 1000) - second, messages: count, bytes })
                }
                return { ...row, lastSecondsHistory: history }
            }),
            ...(declared && !found.length ? { declared } : {}),
            module: Object.values(this.graph.modules).filter((m) =>
                [...m.inputs, ...m.outputs].some((s) => normBase(s.name) === normBase(topic))
            ).map((m) => m.id),
        }
    }

    /** The next message on a channel (asks the spy), with a hex/text preview of its first bytes. */
    async sample(topic: string, timeoutMs = 3000) {
        const entry = [...this.channels.values()].find((e) => e.channel === topic) ??
            [...this.channels.values()].find((e) => normBase(e.channel) === normBase(topic))
        if (!entry) {
            throw new HttpError(404, `nothing has been seen on ${topic} yet; GET api/topics lists live channels`)
        }
        if (!this.spyInput) {
            throw new HttpError(503, "the spy isn't running, so there is nothing to sample from")
        }
        const sample = await new Promise<Sample | null>((resolve) => {
            const waiters = this.sampleWaiters.get(entry.channel) ?? []
            const done = (s: Sample) => {
                clearTimeout(timer)
                resolve(s)
            }
            const timer = setTimeout(() => {
                const list = this.sampleWaiters.get(entry.channel) ?? []
                list.splice(list.indexOf(done), 1)
                resolve(null)
            }, Math.min(Math.max(timeoutMs, 100), 15000))
            waiters.push(done)
            this.sampleWaiters.set(entry.channel, waiters)
            this.spyInput!(`sample ${entry.channel}`)
        })
        if (!sample) {
            throw new HttpError(504, `no message on ${entry.channel} within ${timeoutMs} ms`)
        }
        const head = sample.bytes.subarray(0, SAMPLE_PREVIEW_BYTES)
        return {
            topic: sample.topic,
            transport: sample.transport,
            msgType: channelType(sample.topic).msgType,
            size: sample.size,
            // LCM messages start with the type's 8-byte fingerprint
            ...(sample.transport === "lcm" && sample.bytes.length >= 8
                ? { fingerprint: hex(sample.bytes.subarray(0, 8)) }
                : {}),
            previewBytes: head.length,
            hex: hex(head),
            text: [...head].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""),
            sampledBytes: sample.bytes.length,
        }
    }

    private resolveSample(frame: Record<string, unknown>) {
        const channel = String(frame.channel)
        const waiters = this.sampleWaiters.get(channel)
        if (!waiters?.length) {
            return
        }
        this.sampleWaiters.delete(channel)
        const bytes = Uint8Array.from(atob(String(frame.b64 ?? "")), (c) => c.charCodeAt(0))
        for (const resolve of waiters) {
            resolve({
                topic: channel,
                transport: String(frame.transport),
                size: Number(frame.size ?? bytes.length),
                bytes,
            })
        }
    }

    workersView() {
        const live = !!this.workers && this.now() - this.workers.at < 4000
        return { live, ageMs: this.workers ? this.now() - this.workers.at : null, data: this.workers?.data ?? null }
    }

    setPaused(paused: boolean) {
        if (paused && !this.paused) {
            this.pausedAt = Date.now()
        }
        this.paused = paused
        publishEvent({ type: "paused", paused })
        return { paused }
    }

    reset() {
        this.channels.clear()
        this.workers = null
        publishEvent({ type: "reset" })
    }

    updateSettings(patch: Partial<Settings>) {
        const next = { ...this.settings }
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) {
                continue
            }
            switch (key) {
                case "layout":
                    if (!LAYOUTS.includes(value as Settings["layout"])) {
                        throw new HttpError(400, `layout must be one of ${LAYOUTS.join(", ")}`)
                    }
                    next.layout = value as Settings["layout"]
                    break
                case "sort":
                    if (!["bps", "hz", "name", "messages"].includes(String(value))) {
                        throw new HttpError(400, "sort must be bps, hz, name or messages")
                    }
                    next.sort = value as Settings["sort"]
                    break
                case "transport":
                    if (!["all", "lcm", "zenoh"].includes(String(value))) {
                        throw new HttpError(400, "transport must be all, lcm or zenoh")
                    }
                    next.transport = value as Settings["transport"]
                    break
                case "filter":
                    next.filter = String(value)
                    break
                case "showTopics":
                case "showWorkers":
                    if (typeof value !== "boolean") {
                        throw new HttpError(400, `${key} must be true or false`)
                    }
                    next[key] = value
                    break
                case "pinnedModule":
                    if (value !== null && value !== "" && !this.graph.modules[String(value)]) {
                        throw new HttpError(404, `no module ${value} in the running blueprint`)
                    }
                    next.pinnedModule = value === null || value === "" ? null : String(value)
                    break
            }
        }
        this.settings = next
        publishEvent({ type: "settings", settings: next })
        return next
    }

    /** Re-read the running blueprint from Desktop; true when the graph changed. */
    async refreshGraph(): Promise<boolean> {
        const fetchJson = async (path: string) => {
            try {
                const response = await fetch(`${this.desktopUrl}${path}`)
                if (!response.ok) {
                    await response.body?.cancel()
                    return null
                }
                return await response.json()
            } catch {
                return null
            }
        }
        const runs: { blueprint: string; started_at?: string }[] = (await fetchJson("/dimos/runs"))?.runs ?? []
        let next: Graph = { blueprint: "", modules: {}, edges: [] }
        if (runs.length) {
            runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
            const active = runs[runs.length - 1].blueprint
            const info = await fetchJson(`/dimos/blueprints/${encodeURIComponent(active)}`)
            next = info && Array.isArray(info.modules)
                ? buildGraph(active, info)
                : { blueprint: active, modules: {}, edges: [], unknown: true }
        }
        if (JSON.stringify(next) === JSON.stringify(this.graph)) {
            return false
        }
        this.graph = next
        if (this.settings.pinnedModule && !next.modules[this.settings.pinnedModule]) {
            this.settings = { ...this.settings, pinnedModule: null }
        }
        publishEvent({ type: "graph", graph: next })
        return true
    }
}

function round(value: number) {
    return Math.round(value * 100) / 100
}

function hex(bytes: Uint8Array) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}
