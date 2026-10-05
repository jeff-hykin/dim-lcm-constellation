// The app's HTTP API: every user-facing action is a route here, so the UI and Desktop's agent drive the app the same
// way. `routes` is also served as agent.json (Desktop's agent finds the endpoints there; dimos.yaml repeats them, and
// `deno task check-endpoints` keeps the two in step). Docs: dimos-desktop docs/apps.md, docs/agent.md.

// @ts-types="./dim-app/frontend_publish.d.ts"
import { publishFrontend, stateChanged } from "./dim-app/frontend_publish.js"

export type Params = Record<string, { type: string; description?: string; required?: boolean; items?: unknown }>

export type Route = {
    method: "GET" | "POST" | "PUT" | "DELETE"
    /** relative to the app, e.g. `api/scan`; `{name}` segments become params */
    path: string
    description: string
    params?: Params
    /** "view": what Desktop's screenshot() calls; "context": what desktop_context adds while the app is focused */
    role?: "view" | "context"
    handler: (args: Record<string, unknown>, request: Request) => unknown | Promise<unknown>
}

/** A readable error with an HTTP status: the UI and the agent both show `message`. */
export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

function match(route: Route, method: string, path: string): Record<string, string> | null {
    if (route.method !== method) {
        return null
    }
    const want = route.path.split("/")
    const got = path.split("/")
    if (want.length !== got.length) {
        return null
    }
    const params: Record<string, string> = {}
    for (let i = 0; i < want.length; i++) {
        const name = want[i].match(/^\{(.+)\}$/)?.[1]
        if (name) {
            params[name] = decodeURIComponent(got[i])
        } else if (want[i] !== got[i]) {
            return null
        }
    }
    return params
}

/** What agent.json / dimos.yaml say about the routes. */
export function describe(description: string, routes: Route[]) {
    return {
        description,
        endpoints: routes.map(({ method, path, description, params, role }) => ({
            method,
            path,
            description,
            ...(params ? { params } : {}),
            ...(role ? { role } : {}),
        })),
    }
}

/** Handles `/api/...` + `/agent.json`; null for anything else (the static frontend). */
export async function handle(request: Request, routes: Route[], description: string): Promise<Response | null> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/+/, "")
    if (path === "agent.json") {
        return Response.json(describe(description, routes))
    }
    for (const route of routes) {
        const pathParams = match(route, request.method, path)
        if (!pathParams) {
            continue
        }
        const args: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...pathParams }
        if (request.method !== "GET" && request.method !== "DELETE") {
            const text = await request.text()
            if (text) {
                try {
                    Object.assign(args, JSON.parse(text))
                } catch {
                    return Response.json({ error: "the body isn't JSON" }, { status: 400 })
                }
            }
        }
        for (const [name, spec] of Object.entries(route.params ?? {})) {
            if (spec.required && args[name] === undefined) {
                return Response.json({ error: `${name} is required` }, { status: 400 })
            }
        }
        try {
            const result = await route.handler(args, request)
            return result instanceof Response ? result : Response.json(result ?? { ok: true })
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
        }
    }
    if (path.startsWith("api/")) {
        return Response.json({ error: `no such endpoint: ${request.method} /${path}` }, { status: 404 })
    }
    return null
}

/** Backend → page (Desktop's docs/events.md): Desktop's relay publishes it on `<ns>/apps/<name>/frontend/events`
 * (ordered: one key). */
export function publishEvent(event: unknown) {
    return publishFrontend("events", event)
}

export { publishFrontend, stateChanged }

// Page → backend plumbing (not actions, so not routes; the page calls them, the agent never needs to):
//   POST api/pages/<pageId>   an open page says it's there, every PAGE_BEAT_MS (and when it opens); …/bye: it left
//   POST api/views/<id>       a page's answer to a `view-request` event: {png}
export const PAGE_BEAT_MS = 10_000
const PAGE_GONE_MS = 3 * PAGE_BEAT_MS
const pagesSeen = new Map<string, number>()
const pageListeners = new Set<(message: Record<string, unknown>) => void>()

/** Messages pages send back (here: a rendered view a `view-request` asked for, as `{type: "view", id, png}`). */
export function onPageMessage(listener: (message: Record<string, unknown>) => void): () => void {
    pageListeners.add(listener)
    return () => pageListeners.delete(listener)
}

/** Pages that said they're open in the last 30 s. */
export function openPages(now = Date.now()): number {
    for (const [id, at] of pagesSeen) {
        if (now - at > PAGE_GONE_MS) {
            pagesSeen.delete(id)
        }
    }
    return pagesSeen.size
}

/** Handles the page plumbing above; null for anything else. */
export async function pagePlumbing(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname
    const page = path.match(/^\/api\/pages\/([\w-]+)$/)
    if (page && request.method === "POST") {
        pagesSeen.set(page[1], Date.now())
        return Response.json({ ok: true, beatMs: PAGE_BEAT_MS })
    }
    const bye = path.match(/^\/api\/pages\/([\w-]+)\/bye$/)
    if (bye && request.method === "POST") {
        pagesSeen.delete(bye[1]) // sendBeacon as the page goes away
        return Response.json({ ok: true })
    }
    const view = path.match(/^\/api\/views\/([\w-]+)$/)
    if (view && request.method === "POST") {
        const body = await request.json().catch(() => null)
        for (const listener of pageListeners) {
            listener({ ...(body ?? {}), type: "view", id: view[1] })
        }
        return Response.json({ ok: true })
    }
    return null
}
