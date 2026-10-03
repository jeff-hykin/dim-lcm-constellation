// Every action this app has, as an endpoint (http.ts). The UI calls these; so can Desktop's agent.
import { HttpError, onPageMessage, openPages, publishEvent, type Route } from "./http.ts"
import { LAYOUTS, Monitor, type Settings } from "./monitor.ts"

export const DESCRIPTION =
    "LCM Constellation: live LCM and Zenoh traffic (every channel's rate and message size) over the running blueprint's module graph, plus dtop's per-worker CPU/RAM"

export const monitor = new Monitor(
    Deno.env.get("DIMOS_DESKTOP_URL") ?? "http://127.0.0.1:7077",
)

const bool = (value: unknown, name: string) => {
    if (value === undefined || typeof value === "boolean") {
        return value as boolean | undefined
    }
    if (value === "true" || value === "false") {
        return value === "true"
    }
    throw new HttpError(400, `${name} must be true or false`)
}
const number = (value: unknown, name: string) => {
    if (value === undefined) {
        return undefined
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new HttpError(400, `${name} must be a non-negative number`)
    }
    return parsed
}

const topicParams = {
    filter: {
        type: "string",
        description: "only topics whose channel or message type contains this (case-insensitive)",
    },
    transport: { type: "string", description: "all (default), lcm or zenoh" },
    active: { type: "boolean", description: "only topics with traffic in the last 5 s" },
    sort: { type: "string", description: "bps (default: bandwidth), hz, messages or name" },
    limit: { type: "number", description: "at most this many rows" },
}

/** Ask the open pages to render the graph; the first answer wins. */
function requestView(timeoutMs = 5000): Promise<Record<string, unknown>> {
    if (!openPages()) {
        throw new HttpError(409, "no page is open to draw the graph: open LCM Constellation in Desktop first")
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
        const stop = onPageMessage((message) => {
            if (message.type === "view" && message.id === id) {
                stop()
                clearTimeout(timer)
                resolve(message)
            }
        })
        const timer = setTimeout(() => {
            stop()
            reject(new HttpError(504, "the open page didn't send its view in time"))
        }, timeoutMs)
        publishEvent({ type: "view-request", id })
    })
}

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        description:
            "Overview: the running blueprint, module/topic counts, total rate and bandwidth, the busiest topics, paused or not, the spy's status, workers and the view settings",
        role: "context",
        handler: () => {
            const graph = monitor.graph
            return {
                blueprint: graph.blueprint || null,
                blueprintUnknown: !!graph.unknown,
                modules: Object.keys(graph.modules).length,
                topics: monitor.allTopics().length,
                totals: monitor.totals(),
                busiest: monitor.listTopics({ active: true, limit: 5 }).map((
                    { topic, transport, hz, bytesPerSec, avgMessageBytes },
                ) => ({
                    topic,
                    transport,
                    hz,
                    bytesPerSec,
                    avgMessageBytes,
                })),
                paused: monitor.paused,
                spy: monitor.spy,
                workersLive: monitor.workersView().live,
                settings: monitor.settings,
            }
        },
    },
    {
        method: "GET",
        path: "api/topics",
        description:
            "Every LCM/Zenoh channel seen (and blueprint topics with no traffic yet, declaredOnly): rate (hz), bandwidth (bytesPerSec), average message size, total messages, last seen, publishing/subscribing modules",
        params: topicParams,
        handler: ({ filter, transport, active, sort, limit }) => {
            if (transport !== undefined && !["all", "lcm", "zenoh"].includes(String(transport))) {
                throw new HttpError(400, "transport must be all, lcm or zenoh")
            }
            if (sort !== undefined && !["bps", "hz", "messages", "name"].includes(String(sort))) {
                throw new HttpError(400, "sort must be bps, hz, messages or name")
            }
            const topics = monitor.listTopics({
                filter: filter === undefined ? undefined : String(filter),
                transport: transport === undefined ? undefined : String(transport),
                active: bool(active, "active"),
                sort: sort === undefined ? undefined : String(sort),
                limit: number(limit, "limit"),
            })
            return { paused: monitor.paused, totals: monitor.totals(), topics }
        },
    },
    {
        method: "GET",
        path: "api/topic",
        description:
            "One topic in detail: its channel(s) (exact channel, or every channel with that bare name), rate, sizes, a per-second history of the last 60 s, and the modules on it",
        params: {
            topic: {
                type: "string",
                required: true,
                description: "a channel (/odom#nav_msgs.Odometry) or bare name (odom)",
            },
        },
        handler: ({ topic }) => monitor.topicDetails(String(topic)),
    },
    {
        method: "POST",
        path: "api/topic/sample",
        description:
            "Wait for the next message on a topic and return its size and the first bytes (hex + printable text; an LCM message starts with its type fingerprint)",
        params: {
            topic: { type: "string", required: true, description: "a channel or bare name seen in api/topics" },
            timeoutMs: { type: "number", description: "how long to wait (default 3000, max 15000)" },
        },
        handler: ({ topic, timeoutMs }) => monitor.sample(String(topic), number(timeoutMs, "timeoutMs") ?? 3000),
    },
    {
        method: "GET",
        path: "api/graph",
        description: "The running blueprint's module graph: modules (with in/out streams) and module→topic edges",
        handler: () => monitor.graph,
    },
    {
        method: "POST",
        path: "api/graph/refresh",
        description: "Re-read the running blueprint from Desktop now (it is also re-read every 4 s)",
        handler: async () => ({ changed: await monitor.refreshGraph(), graph: monitor.graph }),
    },
    {
        method: "GET",
        path: "api/workers",
        description:
            "dtop: per-worker CPU, memory (PSS), threads, IO and modules, from /resource_stats (needs a blueprint run with --dtop)",
        handler: () => monitor.workersView(),
    },
    {
        method: "POST",
        path: "api/pause",
        description: "Freeze the traffic readings (rates, counts and the animation hold their current values)",
        handler: () => monitor.setPaused(true),
    },
    {
        method: "POST",
        path: "api/resume",
        description: "Resume live traffic readings after a pause",
        handler: () => monitor.setPaused(false),
    },
    {
        method: "POST",
        path: "api/reset",
        description: "Forget every channel's counts and history (the graph stays)",
        handler: () => {
            monitor.reset()
            return { ok: true }
        },
    },
    {
        method: "GET",
        path: "api/settings",
        description:
            "What the page shows: layout, topic table sort/filter/transport, which panels are open, the pinned module card",
        handler: () => monitor.settings,
    },
    {
        method: "POST",
        path: "api/settings",
        description: "Change what every open page shows; only the fields given change",
        params: {
            layout: { type: "string", description: `graph layout: ${LAYOUTS.join(", ")}` },
            sort: { type: "string", description: "topic table order: bps, hz, messages or name" },
            filter: { type: "string", description: "topic table filter text (empty for none)" },
            transport: { type: "string", description: "topic table transport: all, lcm or zenoh" },
            showTopics: { type: "boolean", description: "show the topics table" },
            showWorkers: { type: "boolean", description: "show the workers (dtop) panel" },
            pinnedModule: { type: "string", description: 'pin this module\'s card open (null or "" to unpin)' },
        },
        handler: (args) => monitor.updateSettings(args as Partial<Settings>),
    },
    {
        method: "GET",
        path: "api/view",
        description: "The graph as the user sees it, as an image (needs the page open)",
        role: "view",
        handler: async () => {
            const answer = await requestView()
            return {
                image: { mimeType: "image/png", data: String(answer.png ?? "") },
                blueprint: monitor.graph.blueprint || null,
                settings: monitor.settings,
            }
        },
    },
]
