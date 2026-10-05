// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives, else a port. What Desktop
// passes: the DIMOS_APP env var, one JSON object (docs/apps.md; dimos_app.ts, with older Desktops' flags as fallback).
import { dimosApp } from "./dimos_app.ts"
import { handle, openPages, pagePlumbing, publishFrontend } from "./http.ts"
import { DESCRIPTION, monitor, routes } from "./routes.ts"
import { runSpy } from "./spy.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend") ?? new URL("../frontend/dist", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    json: "application/json",
    wasm: "application/wasm",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    for (const candidate of [clean, "index.html"]) {
        try {
            const bytes = await Deno.readFile(`${frontend}/${candidate}`)
            const type = types[candidate.split(".").pop() ?? ""] ?? "application/octet-stream"
            return new Response(bytes, { headers: { "content-type": type } })
        } catch {
            // next candidate: unknown paths get the app (hash routing)
        }
    }
    return new Response("not found", { status: 404 })
}

async function serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    return (await pagePlumbing(request)) ?? (await handle(request, routes, DESCRIPTION)) ?? file(path)
}

const GRAPH_RESCAN_MS = 4000
const STATS_MS = 500

monitor.desktopUrl = dimosApp.desktopUrl ?? monitor.desktopUrl
monitor.refreshGraph()
setInterval(() => monitor.refreshGraph(), GRAPH_RESCAN_MS)
// open pages get the topic table and totals twice a second on their frontend topic `stats` (the same numbers api/topics
// gives; frozen while paused); latest-wins data, so unordered, and only while a page is open
setInterval(() => {
    if (!openPages()) {
        return
    }
    const { filter, transport, sort } = monitor.settings
    publishFrontend("stats", {
        type: "stats",
        totals: monitor.totals(),
        topics: monitor.allTopics(),
        table: monitor.listTopics({ filter, transport, sort }),
        workers: monitor.workersView(),
    }, { ordered: false })
}, STATS_MS)
runSpy(monitor)

const socket = dimosApp.socket
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    Deno.serve({ port: Number(flag("port") ?? 8787) }, serve)
}
