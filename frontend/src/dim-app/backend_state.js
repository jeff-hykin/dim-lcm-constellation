// Snapshot + live for a piece of backend state (Desktop's docs/events.md): GET it over HTTP, then re-GET whenever the
// backend says it changed. The backend says so with `stateChanged(key)` (frontend_publish.js), which publishes
// `{key, version}` on `<ns>/apps/<name>/frontend/state/<key>`; the page re-GETs (debounced) when a newer version
// arrives, and after its zenoh-gateway connection comes back (events sent while it was down are gone).
//
//     import { watchBackendState } from "./dim-app/backend_state.js"
//     const watch = watchBackendState("recordings", ({ data, loading, error }) => render(data)) // GET api/state/recordings
//     watch.refresh() // after this page changed it itself (or just wait for the event)
//     watch.stop()
//
// `source` is a key ("recordings": GET `api/state/recordings`, topic `state/recordings`) or a URL relative to the app
// ("api/library?sort=name": its key is the path's last segment, "library", unless `key` says otherwise). React pages
// use react.js's useBackendState, which wraps this.

import { checkTopic } from "./topic.js"
import { getZenoh } from "./zenoh.js"

/**
 * `{ url, key, topic }` for a source: a key (no "/" or "?") or an app-relative URL.
 * @param {string} source
 * @param {{ key?: string, url?: string, topic?: string }} [options]
 */
export function resolveSource(source, options = {}) {
    const isUrl = /[/?]/.test(source)
    const key = options.key ?? (isUrl ? source.split("?")[0].replace(/\/+$/, "").split("/").pop() : source)
    const url = options.url ?? (isUrl ? source : `api/state/${key}`)
    const topic = options.topic ?? `state/${key}`
    checkTopic(topic)
    return { url, key, topic }
}

/**
 * Watch one piece of backend state. `onChange({ data, loading, error, version })` after every GET (loading: no data
 * yet; error: the last GET's failure, data kept).
 * @param {string} source a key or an app-relative URL (see resolveSource)
 * @param {(snapshot: { data: any, loading: boolean, error: Error | null, version: number | null }) => void} onChange
 * @param {{ key?: string, url?: string, topic?: string, debounceMs?: number, zenoh?: any, fetch?: typeof fetch,
 *   href?: string, parse?: (response: Response) => Promise<any>, init?: RequestInit }} [options]
 * @returns {{ refresh(): Promise<void>, stop(): void }}
 */
export function watchBackendState(source, onChange, options = {}) {
    const { url, key, topic } = resolveSource(source, options)
    const debounceMs = options.debounceMs ?? 100
    const zenoh = options.zenoh ?? getZenoh()
    const fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args))
    const parse = options.parse ?? ((response) => response.json())
    const href = new URL(url, options.href ?? globalThis.location?.href).href
    let snapshot = { data: undefined, loading: true, error: null, version: null }
    let seenVersion = -Infinity // the newest version an event announced
    let loadedVersion = -Infinity // the newest version a finished GET is known to include
    let timer = null
    let inFlight = null
    let dirty = false
    let stopped = false
    let waiters = []

    const schedule = (delay) => {
        if (stopped) {
            return
        }
        if (inFlight) {
            dirty = true
            return
        }
        if (timer === null) {
            timer = setTimeout(() => {
                timer = null
                load()
            }, delay)
        }
    }

    const load = () => {
        dirty = false
        const target = seenVersion
        inFlight = (async () => {
            let next
            try {
                const response = await fetchImpl(href, options.init)
                if (!response.ok) {
                    await response.body?.cancel()
                    throw new Error(`GET ${url}: HTTP ${response.status}`)
                }
                const data = await parse(response)
                loadedVersion = Math.max(loadedVersion, target)
                next = {
                    data,
                    loading: false,
                    error: null,
                    version: Number.isFinite(loadedVersion) ? loadedVersion : null,
                }
            } catch (error) {
                next = { ...snapshot, loading: false, error }
            }
            inFlight = null
            if (stopped) {
                return
            }
            snapshot = next
            try {
                onChange(snapshot)
            } catch (error) {
                console.error(`[dim-app] watchBackendState(${key}) onChange threw`, error)
            }
            if (dirty || seenVersion > loadedVersion) {
                schedule(debounceMs)
            } else {
                const done = waiters
                waiters = []
                done.forEach((resolve) => resolve())
            }
        })()
    }

    const offEvent = zenoh.subscribeFrontend(topic, (event) => {
        const version = typeof event?.version === "number" ? event.version : null
        if (version === null) {
            schedule(debounceMs) // no version: every event means "changed"
            return
        }
        if (version <= loadedVersion || version <= seenVersion) {
            return // already have it, or already fetching for a newer one
        }
        seenVersion = version
        schedule(debounceMs)
    })
    const offReconnect = zenoh.onReconnect(() => schedule(0))
    load()

    return {
        refresh() {
            if (stopped) {
                return Promise.resolve()
            }
            const settled = new Promise((resolve) => waiters.push(resolve))
            clearTimeout(timer)
            timer = null
            if (inFlight) {
                dirty = true
            } else {
                load()
            }
            return settled
        },
        stop() {
            stopped = true
            clearTimeout(timer)
            offEvent()
            offReconnect()
            waiters.forEach((resolve) => resolve())
            waiters = []
        },
    }
}
