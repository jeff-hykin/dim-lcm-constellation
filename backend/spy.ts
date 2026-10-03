// Runs the native spy (spy/, Rust: sniffs LCM multicast + Zenoh) and feeds its NDJSON frames to the monitor,
// restarting it if it dies. `nix build .#dimosApp` passes its store path in LCMFLOW_SPY; a `cargo build --release`
// in spy/ is the fallback when run by hand.
import type { Monitor } from "./monitor.ts"

const RESTART_MS = 2000

function spyPath(): string | null {
    for (const path of [Deno.env.get("LCMFLOW_SPY"), new URL("../spy/target/release/spy", import.meta.url).pathname]) {
        try {
            if (path && Deno.statSync(path).isFile) {
                return path
            }
        } catch {
            // not here
        }
    }
    return null
}

async function lines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    let buffer = ""
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        buffer += chunk
        let index
        while ((index = buffer.indexOf("\n")) >= 0) {
            onLine(buffer.slice(0, index).trim())
            buffer = buffer.slice(index + 1)
        }
    }
}

export async function runSpy(monitor: Monitor) {
    const path = spyPath()
    monitor.spy.path = path
    if (!path) {
        monitor.spy.lastError = "no spy binary (set LCMFLOW_SPY, or cargo build --release in spy/): no live traffic"
        console.error(monitor.spy.lastError)
        return
    }
    const encoder = new TextEncoder()
    for (;;) {
        try {
            const child = new Deno.Command(path, { stdin: "piped", stdout: "piped", stderr: "piped" }).spawn()
            const writer = child.stdin.getWriter()
            monitor.spyInput = (line) => void writer.write(encoder.encode(line + "\n")).catch(() => {})
            monitor.spy.running = true
            await Promise.all([
                lines(child.stdout, (line) => {
                    if (line.startsWith("{")) {
                        try {
                            monitor.ingest(JSON.parse(line))
                        } catch {
                            // a partial or non-JSON line
                        }
                    }
                }),
                lines(child.stderr, (line) => line && console.error(`spy: ${line}`)),
                child.status,
            ])
            monitor.spy.lastError = `spy exited (${(await child.status).code})`
        } catch (error) {
            monitor.spy.lastError = `spy failed: ${error instanceof Error ? error.message : error}`
        }
        monitor.spy.running = false
        monitor.spyInput = null
        monitor.spy.restarts++
        console.error(`${monitor.spy.lastError}; restarting`)
        await new Promise((resolve) => setTimeout(resolve, RESTART_MS))
    }
}
