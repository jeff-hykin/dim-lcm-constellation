// lcmflow — backend half (runs in the Deno desktop process).
//
// Ported from the feat/lcmflow-desktop `server.ts`: it subscribes to every LCM
// channel via @dimos/lcm and forwards *metadata only* ({channel, count, bytes},
// batched), and recovers the module↔topic topology from the newest DimOS run
// log's structured "Transport" events. Instead of its own WebSocket server, it
// relays the same `{kind, ...}` frames to the browser over the app-bus.
//
// (The per-edge direction sidecar — `python -m dimos.utils.cli.lcmflow.topology`
// — isn't ported: that module ships only on the lcmflow branch, so the graph
// renders with undirected edges, which the frontend handles.)

// NOTE: vendored copy of @dimos/lcm@0.2.0 with a local fix — upstream never
// joins the multicast group, so its receive path got zero packets (no live
// flow / dtop). See ./lcm_vendor/transport.ts. Swap back to the jsr import
// once the fix lands upstream.
import { LCM } from "./lcm_vendor/mod.ts"
import { DimAppBackend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const BATCH_MS = 50
const TOPOLOGY_RESCAN_MS = 5000

// Self-construct our backend from the shared SDK — the name comes from the
// desktop's registry. (We read LCM directly via the sniff, so no ctx needed.)
const dimApp = new DimAppBackend()

    const home = Deno.env.get("HOME") ?? ""
    let topology = { source: "", edges: [] }

    // ── dtop: per-worker resource stats (folded in from the old lcm_spy app) ──
    // /dimos/resource_stats is pickle-encoded over LCM; we decode it straight from
    // the LCM sniff below (no bridge dependency) and forward it to the frontend on
    // the "lcmflow" app-bus tag, so constellation is a superset of the standalone spy.
    let unpickle = null
    import("https://esm.sh/pickleparser@0.2.1").then((mod) => {
        const Parser = mod.Parser || mod.default?.Parser || mod.default
        if (Parser) unpickle = (buf) => normalize(new Parser().parse(buf))
    }).catch(() => { /* dtop decode unavailable */ })
    function normalize(v) {
        if (v instanceof Map) { const o = {}; for (const [k, val] of v) o[k] = normalize(val); return o }
        if (Array.isArray(v)) return v.map(normalize)
        if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = normalize(v[k]); return o }
        return v
    }
    function onResource(data) {
        if (!unpickle) return
        try {
            const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
            const obj = unpickle(buf)
            if (obj && typeof obj === "object") {
                try { dimApp.send("lcmflow", { kind: "dtop", data: obj }) } catch { /* skip */ }
            }
        } catch { /* undecodable frame — keep last */ }
    }
    // (resource_stats frames are decoded by onResource(), called from the LCM sniff)

    // ── topology: parse "Transport" events from the newest run log ──
    function registryLogs() {
        const found = []
        let entries
        try {
            entries = Deno.readDirSync(`${home}/.local/state/dimos/runs`)
        } catch {
            return found
        }
        for (const entry of entries) {
            if (!entry.name.endsWith(".json")) continue
            try {
                const rec = JSON.parse(Deno.readTextFileSync(`${home}/.local/state/dimos/runs/${entry.name}`))
                if (!rec.log_dir) continue
                const candidate = `${rec.log_dir}/main.jsonl`
                const stat = Deno.statSync(candidate)
                found.push({ path: candidate, mtime: stat.mtime?.getTime() ?? 0 })
            } catch { /* stale entry */ }
        }
        return found
    }
    function findNewestRunLog() {
        let newest = null
        for (const c of registryLogs()) {
            if (!newest || c.mtime > newest.mtime) newest = c
        }
        if (newest) return newest.path
        for (const root of [`${Deno.cwd()}/logs`, `${home}/.local/state/dimos/logs`]) {
            let entries
            try {
                entries = Deno.readDirSync(root)
            } catch {
                continue
            }
            for (const entry of entries) {
                if (!entry.isDirectory) continue
                const candidate = `${root}/${entry.name}/main.jsonl`
                try {
                    const m = Deno.statSync(candidate).mtime?.getTime() ?? 0
                    if (!newest || m > newest.mtime) newest = { path: candidate, mtime: m }
                } catch { /* no main.jsonl */ }
            }
        }
        return newest?.path ?? null
    }
    function parseTopology(path) {
        const edges = []
        const seen = new Set()
        let text
        try {
            text = Deno.readTextFileSync(path)
        } catch {
            return edges
        }
        for (const line of text.split("\n")) {
            if (!line.includes('"Transport"')) continue
            try {
                const rec = JSON.parse(line)
                if (rec.event !== "Transport" || !rec.module) continue
                const name = rec.original_name ?? rec.name ?? ""
                const edge = {
                    module: rec.module, name, topic: rec.topic ?? rec.name ?? "",
                    type: rec.type ?? "", transport: rec.transport ?? "", direction: "",
                }
                const key = `${edge.module}|${edge.topic}|${edge.direction}`
                if (!seen.has(key)) {
                    seen.add(key)
                    edges.push(edge)
                }
            } catch { /* partial line */ }
        }
        return edges
    }
    function refreshTopology() {
        const path = findNewestRunLog()
        if (!path) return false
        const edges = parseTopology(path)
        if (edges.length === 0 && topology.edges.length > 0) return false
        const changed = path !== topology.source || JSON.stringify(edges) !== JSON.stringify(topology.edges)
        topology = { source: path, edges }
        return changed
    }
    function sendTopology() {
        try {
            dimApp.send("lcmflow", { kind: "topology", ...topology })
        } catch { /* skip */ }
    }

    // ── live flow: @dimos/lcm metadata, batched every BATCH_MS ──
    const pending = new Map() // channel -> [count, bytes]
    function note(channel, bytes) {
        const e = pending.get(channel)
        if (e) { e[0] += 1; e[1] += bytes } else { pending.set(channel, [1, bytes]) }
    }
    setInterval(() => {
        if (pending.size === 0) return
        const events = []
        for (const [channel, [count, bytes]] of pending) events.push([channel, count, bytes])
        pending.clear()
        try {
            dimApp.send("lcmflow", { kind: "packets", t: Date.now(), events })
        } catch { /* skip */ }
    }, BATCH_MS)

    // topology now + rescan; a fresh frontend `hello` gets the current topology
    refreshTopology()
    setInterval(() => { if (refreshTopology()) sendTopology() }, TOPOLOGY_RESCAN_MS)
    dimApp.onReceive((kind) => { if (kind === "hello") sendTopology() })

    // subscribe to all channels (reads only byte length — payloads never decoded)
    ;(async () => {
        try {
            const lcm = new LCM()
            await lcm.start()
            lcm.subscribeRaw("*", (msg) => {
                note(msg.channel, msg.data.byteLength)
                if (msg.channel.includes("resource_stats")) onResource(msg.data)
            })
            await lcm.run()
        } catch (err) {
            console.error(`lcmflow: LCM sniff unavailable — ${err.message}`)
        }
    })()
