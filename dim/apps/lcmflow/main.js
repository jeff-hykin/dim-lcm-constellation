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
// dimOS Desktop's /dimos/ API gives the running blueprints and each blueprint's module streams.
const DESKTOP_URL = Deno.env.get("DIMOS_DESKTOP_URL") ?? "http://127.0.0.1:7077"

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
// Desktop lists live runs (the dimos run registry) at /dimos/runs and each
// blueprint's modules + typed streams at /dimos/blueprints/<name>. We pick the
// newest-started run, then join module streams by name to form topics with real
// pub/sub direction — publishers are a module's "out" streams, subscribers its
// "in" ones. (Remapping can rename streams, so a handful of topics may not fuse;
// good enough — the runtime spy still lights up whatever actually flows.)
async function fetchJson(url) {
    try {
        const res = await fetch(url)
        if (!res.ok) { await res.body?.cancel(); return null }
        return await res.json()
    } catch { return null }
}
// The name of the blueprint that is actually running (newest-started live run), or null.
async function pickActiveBlueprint() {
    const runs = (await fetchJson(`${DESKTOP_URL}/dimos/runs`))?.runs ?? []
    if (runs.length === 0) return null
    runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    return runs[runs.length - 1].blueprint
}
function buildGraph(info) {
    const modules = {}          // id -> card payload
    const edges = []            // { module, topic, type, direction }
    const seen = new Set()
    const addEdge = (module, topic, type, direction) => {
        const key = `${module}|${topic}|${direction}`
        if (seen.has(key)) return
        seen.add(key)
        edges.push({ module, topic, type, direction, declared: null })
    }
    for (const m of info.modules ?? []) {
        const streams = m.streams ?? []
        const pick = (dir) => streams.filter((s) => s.direction === dir || s.direction === "inout").map(({ name, type }) => ({ name, type }))
        modules[m.name] = {
            id: m.name, label: String(m.class ?? m.name).split(".").pop(), doc: "",
            inputs: pick("in"), outputs: pick("out"), rpcs: [], skills: [],
        }
        for (const s of modules[m.name].outputs) addEdge(m.name, s.name, s.type ?? "", "out")
        for (const s of modules[m.name].inputs) addEdge(m.name, s.name, s.type ?? "", "in")
    }
    return { blueprint: info.name, modules, edges }
}
async function refreshGraph() {
    const active = await pickActiveBlueprint()
    if (!active) {
        if (graph.blueprint === "") return false
        graph = { blueprint: "", modules: {}, edges: [] }
        return true
    }
    // Running blueprint whose modules Desktop's dimos knows → full graph; otherwise
    // report it as running with no module metadata.
    const info = await fetchJson(`${DESKTOP_URL}/dimos/blueprints/${encodeURIComponent(active)}`)
    const next = info && Array.isArray(info.modules)
        ? buildGraph({ ...info, name: active })
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
// A dev build in spy/target wins; otherwise a prebuilt spy for this platform,
// downloaded once from the `latest` release that CI builds from master (see
// .github/workflows/release.yml), so a user machine needs neither cargo nor a
// compile. Building with cargo is the last resort.
const SPY_RELEASE_URL = "https://github.com/jeff-hykin/dim-lcm-constellation/releases/latest/download"
function spyBinPath() {
    const ext = Deno.build.os === "windows" ? ".exe" : ""
    return `${appDir}/spy/target/release/spy${ext}`
}
// Asset name in the release: spy-<arch>-<os>, e.g. spy-x86_64-macos.
function spyAssetName() {
    const os = { darwin: "macos", linux: "linux" }[Deno.build.os]
    return os ? `spy-${Deno.build.arch}-${os}` : null
}
function prebuiltSpyPath() {
    const asset = spyAssetName()
    return asset ? `${appDir}/spy/bin/${asset}` : null
}
async function downloadPrebuiltSpy() {
    const path = prebuiltSpyPath()
    if (!path) return null
    const url = `${SPY_RELEASE_URL}/${spyAssetName()}`
    console.error(`lcmflow: fetching prebuilt spy ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    await Deno.mkdir(`${appDir}/spy/bin`, { recursive: true })
    // Write beside the target and rename in: a half-written binary must never be
    // exec'd, and macOS refuses (SIGKILL) a binary overwritten in place after it ran.
    const tmp = `${path}.part`
    await Deno.writeFile(tmp, new Uint8Array(await res.arrayBuffer()))
    await Deno.chmod(tmp, 0o755)
    await Deno.rename(tmp, path)
    return path
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
    try { Deno.statSync(bin); return bin } catch { /* no dev build */ }
    // built by the install step (`nix run .#install`) when no release binary could be fetched
    try { Deno.statSync(`${appDir}/spy/result/bin/spy`); return `${appDir}/spy/result/bin/spy` } catch { /* none */ }
    const prebuilt = prebuiltSpyPath()
    if (prebuilt) {
        try { Deno.statSync(prebuilt); return prebuilt } catch { /* not downloaded yet */ }
        try { return await downloadPrebuiltSpy() } catch (err) {
            console.error(`lcmflow: could not fetch a prebuilt spy (${err.message}) — building it instead`)
        }
    }
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
