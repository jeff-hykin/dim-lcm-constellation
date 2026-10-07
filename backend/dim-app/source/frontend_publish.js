// Backend → frontend for an app's server (Deno; Desktop's docs/events.md): one HTTP call to Desktop's relay,
// `POST <desktopUrl>/desktop/frontend/<app>/<topic…>`, which publishes the body unchanged on
// `<ns>/apps/<app>/frontend/<topic…>`, where the app's pages subscribe (zenoh.js's subscribeFrontend).
//
//     import { publishFrontend, stateChanged } from "./dim-app/source/frontend_publish.js"
//     publishFrontend("status", { battery: 0.82 })   // JSON
//     stateChanged("recordings")                     // {key:"recordings", version} on state/recordings: pages re-GET
//
// Desktop's URL and the app's name come from DIMOS_APP (app_env.js). Calls are sent in order (one at a time, so
// events arrive in the order they were published); `{ ordered: false }` sends at once (for latest-wins data). Events
// should stay small (≤ 64 KiB; the relay refuses > 1 MiB): put an id or version in the event and serve the bytes over
// HTTP. Never throws for a failed publish (logs once per kind of failure and resolves to null).

import { readDimosApp } from "./app_env.js"
import { checkTopic } from "./topic.js"

const MAX_QUEUE = 10_000
const warned = new Set()
const queue = []
let draining = false

function warnOnce(kind, message) {
    if (!warned.has(kind)) {
        warned.add(kind)
        console.warn(`[dim-app] publishFrontend: ${message}`)
    }
}

function encode(payload, contentType) {
    if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
        return { body: payload, contentType: contentType ?? "application/octet-stream" }
    }
    if (typeof payload === "string" && contentType) {
        return { body: payload, contentType }
    }
    return { body: JSON.stringify(payload ?? null), contentType: contentType ?? "application/json" }
}

async function send({ url, body, contentType, fetchImpl }) {
    try {
        const response = await fetchImpl(url, { method: "POST", headers: { "content-type": contentType }, body })
        if (!response.ok) {
            const text = await response.text().catch(() => "")
            warnOnce(`http-${response.status}`, `${url}: HTTP ${response.status} ${text.slice(0, 200)}`)
            return null
        }
        return await response.json()
    } catch (error) {
        warnOnce(`fetch-${error?.name}`, `${url}: ${error?.message ?? error} (is Desktop up?)`)
        return null
    }
}

async function drain() {
    draining = true
    while (queue.length) {
        const item = queue.shift()
        item.resolve(await send(item))
    }
    draining = false
}

/**
 * Publish `payload` on this app's `<ns>/apps/<name>/frontend/<topic>`. JSON unless it's bytes (Uint8Array) or a string
 * with a `contentType`.
 * @param {string} topic one or more chunks of letters, digits, `-`, `_`, `.` (e.g. "status", "map/cloud")
 * @param {unknown} payload
 * @param {{ contentType?: string, ordered?: boolean, app?: { name?: string | null, desktopUrl?: string | null },
 *   fetch?: typeof fetch }} [options] `app`: default readDimosApp()
 * @returns {Promise<{ ok: true, key: string, bytes: number } | null>}
 */
export function publishFrontend(topic, payload, options = {}) {
    checkTopic(topic)
    const app = options.app ?? readDimosApp()
    if (!app?.desktopUrl || !app?.name) {
        warnOnce("no-desktop", "no Desktop URL or app name in DIMOS_APP (not run by dimOS Desktop?); not published")
        return Promise.resolve(null)
    }
    const { body, contentType } = encode(payload, options.contentType)
    const url = `${app.desktopUrl.replace(/\/+$/, "")}/desktop/frontend/${encodeURIComponent(app.name)}/${topic}`
    const item = { url, body, contentType, fetchImpl: options.fetch ?? ((...args) => globalThis.fetch(...args)) }
    if (options.ordered === false) {
        return send(item)
    }
    return new Promise((resolve) => {
        if (queue.length >= MAX_QUEUE) {
            warnOnce(
                "queue-full",
                `more than ${MAX_QUEUE} publishes waiting (Desktop slow or down); dropping the oldest`,
            )
            queue.shift().resolve(null)
        }
        queue.push({ ...item, resolve })
        if (!draining) {
            drain()
        }
    })
}

const versions = new Map()

/**
 * Tell this app's pages that the state `key` changed: publishes `{ key, version }` on `state/<key>`, and pages watching
 * it (backend_state.js / react.js's useBackendState) re-GET. `version` defaults to a number that only grows, also
 * across restarts (milliseconds since 1970, bumped past the last one).
 * @param {string} key
 * @param {number} [version]
 * @param {Parameters<typeof publishFrontend>[2]} [options]
 */
export function stateChanged(key, version, options = {}) {
    const next = version ?? Math.max(Date.now(), (versions.get(key) ?? 0) + 1)
    versions.set(key, next)
    return publishFrontend(`state/${key}`, { key, version: next }, options)
}
