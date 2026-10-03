// The backend's shapes (backend/monitor.ts), as the page sees them.
export type Stream = { name: string; type?: string; wire?: string }
export type Method = { name: string; params?: { name: string }[]; return_type?: string }
export type ModuleCard = {
    id: string
    label: string
    doc: string
    inputs: Stream[]
    outputs: Stream[]
    rpcs: Method[]
    skills: Method[]
}
export type GraphEdge = {
    module: string
    topic: string
    type: string
    direction: "in" | "out"
    declared: string | null
}
export type Graph = { blueprint: string; unknown?: boolean; modules: Record<string, ModuleCard>; edges: GraphEdge[] }

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

export type Totals = { hz: number; bytesPerSec: number; channels: number; liveChannels: number }

export type Settings = {
    layout: "hierarchy" | "organic" | "force" | "radial" | "circular"
    sort: "bps" | "hz" | "name" | "messages"
    filter: string
    transport: "all" | "lcm" | "zenoh"
    showTopics: boolean
    showWorkers: boolean
    pinnedModule: string | null
}

export type WorkerStats = {
    worker_id?: number
    pid?: number
    alive?: boolean
    dedicated?: boolean
    modules?: string[]
    cpu_percent?: number
    pss?: number
    num_threads?: number
    num_children?: number
    num_fds?: number
    cpu_time_user?: number
    cpu_time_system?: number
    cpu_time_iowait?: number
    io_read_bytes?: number
    io_write_bytes?: number
    children?: { name?: string; pid?: number; cpu_percent?: number }[]
}
export type WorkersView = {
    live: boolean
    ageMs: number | null
    data: { coordinator?: WorkerStats; workers?: WorkerStats[] } | null
}

export type State = {
    blueprint: string | null
    paused: boolean
    totals: Totals
    settings: Settings
}

export type AppEvent =
    | { type: "graph"; graph: Graph }
    | { type: "packets"; events: [string, string, number, number][] }
    | { type: "stats"; totals: Totals; topics: TopicRow[]; table: TopicRow[]; workers: WorkersView }
    | { type: "workers" } & WorkersView
    | { type: "settings"; settings: Settings }
    | { type: "paused"; paused: boolean }
    | { type: "reset" }
    | { type: "view-request"; id: string }
