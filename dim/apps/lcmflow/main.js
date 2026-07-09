// lcmflow — backend half (runs in the Deno desktop process).
//
// This is a thin launcher/relay around the native `spy` binary (Rust, in ./spy).
// The spy passively sniffs BOTH transports dimos uses — LCM (UDP multicast) and
// Zenoh (peer `**` subscriber) — and prints newline-delimited JSON metadata on
// stdout. We forward those frames to the browser over the app-bus, and recover
// the module↔topic topology from the newest DimOS run log's "Transport" events.
//
// dim's desktop only auto-launches a `main.js`/`main.py` backend (no native-binary
// hook), so this JS shim is the entrypoint; the actual protocol spying is Rust.

import { DimAppBackend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const TOPOLOGY_RESCAN_MS = 5000
const SPY_RESTART_MS = 2000

const dimApp = new DimAppBackend()

const home = Deno.env.get("HOME") ?? ""
const appDir = import.meta.dirname ?? "."
let topology = { source: "", edges: [] }

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

// ── topology: parse "Transport" events from the newest run log ────────────────
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

// topology now + rescan; a fresh frontend `hello` gets the current topology
refreshTopology()
setInterval(() => { if (refreshTopology()) sendTopology() }, TOPOLOGY_RESCAN_MS)
dimApp.onReceive((kind) => { if (kind === "hello") sendTopology() })

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
