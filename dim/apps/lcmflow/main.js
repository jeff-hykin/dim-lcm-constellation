// lcmflow — backend half (runs in the Deno desktop process).
//
// The graph itself comes from the currently-active DimOS *blueprint*: we ask the
// desktop server (dimos-helm) for its blueprint/module metadata — the same source
// the blueprint launcher uses — and build a module↔topic graph with real pub/sub
// direction and docstrings. The native `spy` binary (Rust, in ./spy) passively
// sniffs BOTH transports dimos uses — LCM (UDP multicast) and Zenoh (peer `**`
// subscriber) — and prints newline-delimited JSON on stdout; those frames only
// *animate* the already-drawn graph (live rates + lit edges), they don't define it.
//
// dim's desktop only auto-launches a `main.js`/`main.py` backend (no native-binary
// hook), so this JS shim is the entrypoint; the actual protocol spying is Rust.

import { DimAppBackend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const GRAPH_RESCAN_MS = 4000
const SPY_RESTART_MS = 2000
// The desktop server (dimos-helm) that serves this app also exposes the blueprint
// metadata API. It normally lives on :1024; allow an override for odd setups.
const HELM_URL = Deno.env.get("DIM_HELM_URL") ?? "http://localhost:1024"

const dimApp = new DimAppBackend()

const home = Deno.env.get("HOME") ?? ""
const appDir = import.meta.dirname ?? "."
let graph = { blueprint: "", modules: {}, edges: [] }

// ── dtop: per-worker resource stats ───────────────────────────────────────────
// /dimos/resource_stats is pickle-encoded; the spy forwards the raw payload as
// base64 (frame kind:"raw"), and we decode it here so constellation stays a
// superset of the standalone spy app.
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
function onResourceB64(b64) {
    if (!unpickle) return
    try {
        const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const obj = unpickle(buf)
        if (obj && typeof obj === "object") {
            try { dimApp.send("lcmflow", { kind: "dtop", data: obj }) } catch { /* skip */ }
        }
    } catch { /* undecodable frame — keep last */ }
}

// ── graph: build from the active blueprint's module metadata ──────────────────
// The desktop server exposes /api/dimos-info (blueprints + per-module typed
// inputs/outputs + docstrings) and tracks launched blueprints in runs.json. We
// pick the active blueprint, then join module streams by name to form topics with
// real pub/sub direction — publishers are a module's `outputs`, subscribers its
// `inputs`. (Remapping can rename streams, so a handful of topics may not fuse;
// good enough — the runtime spy still lights up whatever actually flows.)
async function fetchJson(url) {
    try {
        const res = await fetch(url)
        if (!res.ok) { await res.body?.cancel(); return null }
        return await res.json()
    } catch { return null }
}
function alivePids() {
    // one `ps` snapshot → set of live pids, so we can prefer a running blueprint.
    try {
        const out = new Deno.Command("ps", { args: ["-eo", "pid="], stdout: "piped" }).outputSync()
        const text = new TextDecoder().decode(out.stdout)
        return new Set(text.split("\n").map((s) => Number(s.trim())).filter(Boolean))
    } catch { return new Set() }
}
// The dimos run registry (~/.local/state/dimos/runs/<run_id>.json) — the
// canonical record of running blueprints, the same source `dimos stop` reads.
// Every launch (terminal or desktop) writes one file with the blueprint name +
// pid; keep only entries whose pid is alive. Newest-started last.
function readDimosRegistry() {
    const dir = `${home}/.local/state/dimos/runs`
    const live = alivePids()
    const out = []
    let names = []
    try {
        names = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".json"))
    } catch { return [] }
    for (const name of names) {
        try {
            const rec = JSON.parse(Deno.readTextFileSync(`${dir}/${name}`))
            if (!rec || typeof rec.blueprint !== "string" || !rec.pid) continue
            if (!live.has(Number(rec.pid))) continue
            out.push({ name: rec.blueprint, started: rec.started_at ?? "" })
        } catch { /* stale / corrupt entry */ }
    }
    out.sort((a, b) => a.started.localeCompare(b.started))
    return out
}
// The name of the blueprint that is actually running: the newest-started live
// entry in the dimos run registry (the same source `dimos stop` reads). Returns
// null when nothing is running. The name may be one the desktop's dimos dir
// doesn't know.
function pickActiveBlueprint() {
    const reg = readDimosRegistry()
    if (reg.length > 0) return reg[reg.length - 1].name
    return null
}
function buildGraph(bp, info) {
    const modsById = new Map(info.modules.map((m) => [m.id, m]))
    const modules = {}          // id -> card payload
    const edges = []            // { module, topic, type, direction }
    const seen = new Set()
    const addEdge = (module, topic, type, direction) => {
        const key = `${module}|${topic}|${direction}`
        if (seen.has(key)) return
        seen.add(key)
        edges.push({ module, topic, type, direction })
    }
    // A blueprint's `.remappings([(Module, declared, wire)])` renames a module's
    // stream to the channel it actually rides. Fuse on the wire name so a renamed
    // publisher joins its subscriber (and matches live spy traffic) — otherwise a
    // pub declared `twist_command` remapped to `cmd_vel` never meets `cmd_vel`.
    const remap = new Map((bp.remappings ?? []).map((r) => [`${r.module}|${r.from}`, r.to]))
    const wireName = (id, name) => remap.get(`${id}|${name}`) ?? name
    for (const id of bp.modules) {
        const m = modsById.get(id)
        if (!m) continue
        modules[id] = {
            id, label: m.class_name ?? id, doc: m.doc ?? "",
            inputs: m.inputs ?? [], outputs: m.outputs ?? [],
            rpcs: m.rpcs ?? [], skills: m.skills ?? [],
        }
        for (const s of m.outputs ?? []) addEdge(id, wireName(id, s.name), s.type ?? "", "out")
        for (const s of m.inputs ?? []) addEdge(id, wireName(id, s.name), s.type ?? "", "in")
    }
    return { blueprint: bp.name, modules, edges }
}
async function refreshGraph() {
    const active = pickActiveBlueprint()
    if (!active) {
        if (graph.blueprint === "") return false
        graph = { blueprint: "", modules: {}, edges: [] }
        return true
    }
    const info = await fetchJson(`${HELM_URL}/api/dimos-info`)
    const byName = (info && Array.isArray(info.blueprints))
        ? new Map(info.blueprints.map((b) => [b.name, b]))
        : new Map()
    // Running blueprint whose modules the desktop's dimos dir knows → full graph.
    // Otherwise report it as running with no module metadata (add its dir to the
    // desktop's dimos dirs to render the flow).
    const next = byName.has(active)
        ? buildGraph(byName.get(active), info)
        : { blueprint: active, modules: {}, edges: [], unknown: true }
    if (JSON.stringify(next) === JSON.stringify(graph)) return false
    graph = next
    return true
}
function sendGraph() {
    try { dimApp.send("lcmflow", { kind: "graph", ...graph }) } catch { /* skip */ }
}

// graph now + rescan; a fresh frontend `hello` gets the current graph
refreshGraph().then((ok) => { if (ok) sendGraph() })
setInterval(() => { refreshGraph().then((ok) => { if (ok) sendGraph() }) }, GRAPH_RESCAN_MS)
dimApp.onReceive((kind) => { if (kind === "hello") sendGraph() })

// ── native spy: LCM + Zenoh metadata over stdout ─────────────────────────────
function spyBinPath() {
    const ext = Deno.build.os === "windows" ? ".exe" : ""
    return `${appDir}/spy/target/release/spy${ext}`
}
function resolveCargo() {
    for (const c of ["cargo", `${home}/.cargo/bin/cargo`]) {
        try {
            if (c.includes("/")) { Deno.statSync(c); return c }
            return c // rely on PATH lookup
        } catch { /* try next */ }
    }
    return "cargo"
}
async function ensureSpyBuilt() {
    const bin = spyBinPath()
    try { Deno.statSync(bin); return bin } catch { /* needs build */ }
    console.error("lcmflow: building native spy (first run, may take a few minutes)…")
    try {
        const build = new Deno.Command(resolveCargo(), {
            args: ["build", "--release"],
            cwd: `${appDir}/spy`,
            stdout: "inherit",
            stderr: "inherit",
        }).spawn()
        const status = await build.status
        if (!status.success) {
            console.error("lcmflow: spy build failed — no live traffic until it builds")
            return null
        }
    } catch (err) {
        console.error(`lcmflow: cannot build spy (${err.message}) — is cargo installed?`)
        return null
    }
    try { Deno.statSync(bin); return bin } catch { return null }
}
function handleFrame(frame) {
    if (frame.kind === "packets") {
        // events: [[transport, channel, count, bytes], ...] — forwarded verbatim.
        try { dimApp.send("lcmflow", frame) } catch { /* skip */ }
    } else if (frame.kind === "raw" && typeof frame.channel === "string" && frame.channel.includes("resource_stats")) {
        onResourceB64(frame.b64)
    }
}
async function pumpStdout(stream) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        let idx
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith("{")) continue // ignore any non-JSON logging
            let frame
            try { frame = JSON.parse(line) } catch { continue }
            handleFrame(frame)
        }
    }
}
async function pumpStderr(stream) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value.trim()) console.error(`spy: ${value.trimEnd()}`)
    }
}
async function runSpy() {
    const bin = await ensureSpyBuilt()
    if (!bin) return
    for (;;) {
        try {
            const child = new Deno.Command(bin, { stdout: "piped", stderr: "piped" }).spawn()
            await Promise.all([pumpStdout(child.stdout), pumpStderr(child.stderr), child.status])
        } catch (err) {
            console.error(`lcmflow: spy process error — ${err.message}`)
        }
        console.error("lcmflow: spy exited; restarting shortly")
        await new Promise((r) => setTimeout(r, SPY_RESTART_MS))
    }
}
runSpy()
