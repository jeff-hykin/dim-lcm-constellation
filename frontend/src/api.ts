// The app's backend API (backend/routes.ts), by relative URL: the page lives at Desktop's /apps/<name>/.
import type { AppEvent } from "./types.ts"

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

/** The backend's events (api/events/ws), reconnecting with backoff. `send` answers the backend on the same socket. */
export function events(onEvent: (event: AppEvent) => void, onConnected?: (connected: boolean) => void) {
    let socket: WebSocket | null = null
    let delay = 500
    let stopped = false
    const open = () => {
        const url = new URL("api/events/ws", location.href)
        url.protocol = url.protocol.replace("http", "ws")
        socket = new WebSocket(url)
        socket.onopen = () => {
            delay = 500
            onConnected?.(true)
        }
        socket.onmessage = (message) => {
            let event: AppEvent
            try {
                event = JSON.parse(message.data)
            } catch {
                return
            }
            onEvent(event)
        }
        socket.onclose = () => {
            onConnected?.(false)
            if (!stopped) {
                setTimeout(open, delay)
                delay = Math.min(delay * 2, 10_000)
            }
        }
    }
    open()
    return {
        send: (message: unknown) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message)),
        stop: () => {
            stopped = true
            socket?.close()
        },
    }
}
