// The app's backend API (backend/routes.ts), by relative URL: the page lives at Desktop's /apps/<name>/.
import type { AppEvent } from "./types.ts"
import { appEvents } from "./dim-app/source/events.js"
import { getZenoh } from "./dim-app/source/zenoh.js"

export class ApiError extends Error {}

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
        throw new ApiError(data?.error ?? `${response.status} ${response.statusText}`)
    }
    return data as T
}

/**
 * The backend's events over the page's one zenoh-gateway connection (Desktop's docs/events.md): the ordered frontend topic
 * `events`, plus `stats` and `packets` (latest-wins). `onConnected(true)` on connect and every reconnect (re-GET then),
 * `(false)` when lost. The page tells the backend it's open (POST api/pages/<id>, every 10 s) so it publishes stats, and
 * `send` answers a view-request (POST api/views/<id>).
 */
export function events(onEvent: (event: AppEvent) => void, onConnected?: (connected: boolean) => void) {
    const zenoh = getZenoh()
    const pageId = crypto.randomUUID()
    const beat = () => fetch(`api/pages/${pageId}`, { method: "POST" }).catch(() => {})
    beat()
    const timer = setInterval(beat, 10_000)
    const bye = () => navigator.sendBeacon?.(`api/pages/${pageId}/bye`)
    const offs = [
        appEvents((event) => onEvent(event as AppEvent), {
            onOpen: () => onConnected?.(true),
            onClose: () => onConnected?.(false),
        }),
        zenoh.subscribeFrontend<AppEvent>("stats", onEvent, { delivery: "latest" }),
        zenoh.subscribeFrontend<AppEvent>("packets", onEvent, { delivery: "latest" }),
    ]
    return {
        send: (message: { type: "view"; id: string; png: string }) =>
            call("POST", `api/views/${message.id}`, { png: message.png }).catch(() => {}),
        stop: () => {
            clearInterval(timer)
            bye()
            offs.forEach((off) => off())
        },
    }
}
