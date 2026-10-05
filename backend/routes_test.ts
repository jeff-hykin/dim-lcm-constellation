import { assert, assertEquals, assertMatch } from "@std/assert"
import { handle, pagePlumbing } from "./http.ts"
import { unpickle } from "./pickle.ts"
import { DESCRIPTION, monitor, routes } from "./routes.ts"

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        DESCRIPTION,
    )
    return { status: response!.status, json: await response!.json() }
}

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

// a stand-in Desktop with one running blueprint
const desktop = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
    const path = new URL(request.url).pathname
    if (path === "/dimos/runs") {
        return Response.json({ runs: [{ blueprint: "demo", started_at: "2026-10-03T00:00:00Z" }] })
    }
    if (path === "/dimos/blueprints/demo") {
        return Response.json({
            modules: [
                {
                    name: "camera",
                    class: "dimos.Camera",
                    streams: [{ name: "image", type: "Image", direction: "out" }],
                },
                {
                    name: "detector",
                    class: "dimos.Detector",
                    streams: [{ name: "image", type: "Image", direction: "in" }, {
                        name: "boxes",
                        type: "Detection",
                        direction: "out",
                    }],
                },
            ],
        })
    }
    return new Response("no", { status: 404 })
})

monitor.desktopUrl = `http://127.0.0.1:${desktop.addr.port}`

Deno.test({
    name: "every route: happy path and a readable error",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        // graph
        const refreshed = await call("POST", "api/graph/refresh")
        assertEquals(refreshed.json.changed, true)
        assertEquals(Object.keys((await call("GET", "api/graph")).json.modules), ["camera", "detector"])

        // traffic: 10 images of 1000 B and 4 odom messages over zenoh
        monitor.ingest({
            kind: "packets",
            events: [["lcm", "/image#sensor_msgs.Image", 10, 10000], ["zenoh", "dimos/odom/nav_msgs.Odometry", 4, 400]],
        })
        const topics = (await call("GET", "api/topics")).json.topics
        assertEquals(topics[0].topic, "/image#sensor_msgs.Image")
        assertEquals(topics[0].hz, 2)
        assertEquals(topics[0].avgMessageBytes, 1000)
        assertEquals(topics[0].publishers, ["camera"])
        assertEquals(topics[0].subscribers, ["detector"])
        assert(topics.some((t: { topic: string; declaredOnly?: boolean }) => t.topic === "boxes" && t.declaredOnly))
        assertEquals((await call("GET", "api/topics?transport=zenoh")).json.topics.length, 1)
        assertEquals((await call("GET", "api/topics?filter=odom&limit=5")).json.topics[0].name, "odom")
        assertEquals((await call("GET", "api/topics?transport=udp")).status, 400)
        assertEquals((await call("GET", "api/topics?limit=-1")).status, 400)

        // one topic
        const detail = (await call("GET", "api/topic?topic=image")).json
        assertEquals(detail.channels[0].messages, 10)
        assertEquals(detail.channels[0].lastSecondsHistory.length, 60)
        assertEquals((await call("GET", "api/topic?topic=nope")).status, 404)
        assertEquals((await call("GET", "api/topic")).status, 400)

        // sample: the spy answers a `sample <channel>` line
        monitor.spyInput = (line) => {
            const channel = line.replace(/^sample /, "")
            setTimeout(
                () =>
                    monitor.ingest({
                        kind: "sample",
                        transport: "lcm",
                        channel,
                        size: 12,
                        b64: b64([1, 2, 3, 4, 5, 6, 7, 8, 72, 105, 0, 9]),
                    }),
                10,
            )
        }
        const sample = (await call("POST", "api/topic/sample", { topic: "image" })).json
        assertEquals(sample.fingerprint, "0102030405060708")
        assertEquals(sample.size, 12)
        assertMatch(sample.text, /Hi/)
        monitor.spyInput = () => {}
        assertEquals((await call("POST", "api/topic/sample", { topic: "image", timeoutMs: 100 })).status, 504)
        assertEquals((await call("POST", "api/topic/sample", { topic: "never_seen" })).status, 404)
        monitor.spyInput = null

        // state
        const state = (await call("GET", "api/state")).json
        assertEquals(state.blueprint, "demo")
        assertEquals(state.busiest.length, 2)
        assertEquals(state.totals.liveChannels, 2)

        // pause freezes the readings; resume lets them move again
        assertEquals((await call("POST", "api/pause")).json, { paused: true })
        monitor.ingest({ kind: "packets", events: [["lcm", "/image#sensor_msgs.Image", 50, 50000]] })
        assertEquals((await call("GET", "api/topic?topic=image")).json.channels[0].messages, 10)
        assertEquals((await call("POST", "api/resume")).json, { paused: false })
        monitor.ingest({ kind: "packets", events: [["lcm", "/image#sensor_msgs.Image", 5, 5000]] })
        assertEquals((await call("GET", "api/topic?topic=image")).json.channels[0].messages, 15)
        assertEquals((await call("POST", "api/pause", "not json" as unknown as object)).status, 200)
        await call("POST", "api/resume")

        // workers: a pickled /resource_stats frame
        const pickled = "gASVNgAAAAAAAAB9lCiMC2Nvb3JkaW5hdG9ylH2UjANwaWSUSwFzjAd3b3JrZXJzlF2UfZSMA3Bzc5RLAnNhdS4="
        monitor.ingest({ kind: "raw", transport: "lcm", channel: "/resource_stats", b64: pickled })
        const workers = (await call("GET", "api/workers")).json
        assertEquals(workers.live, true)
        assertEquals(workers.data, { coordinator: { pid: 1 }, workers: [{ pss: 2 }] })

        // settings
        assertEquals(
            (await call("POST", "api/settings", { layout: "radial", filter: "img", pinnedModule: "camera" })).json
                .layout,
            "radial",
        )
        assertEquals((await call("GET", "api/settings")).json.pinnedModule, "camera")
        assertEquals((await call("POST", "api/settings", { layout: "spiral" })).status, 400)
        assertEquals((await call("POST", "api/settings", { pinnedModule: "ghost" })).status, 404)
        assertEquals((await call("POST", "api/settings", { showTopics: "yes" })).status, 400)

        // reset
        assertEquals((await call("POST", "api/reset")).json, { ok: true })
        assertEquals(
            (await call("GET", "api/topics")).json.topics.filter((t: { declaredOnly?: boolean }) => !t.declaredOnly),
            [],
        )
        assertEquals((await call("POST", "api/reset", "{")).status, 200)

        // a Desktop that isn't there leaves no blueprint, and says nothing changed the second time
        monitor.desktopUrl = "http://127.0.0.1:9"
        assertEquals((await call("POST", "api/graph/refresh")).json.changed, true)
        assertEquals((await call("POST", "api/graph/refresh")).json.changed, false)
        assertEquals((await call("GET", "api/graph")).json.blueprint, "")

        assertEquals((await call("GET", "api/nope")).status, 404)
    },
})

Deno.test({
    name: "api/view asks an open page for its picture",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        assertEquals((await call("GET", "api/view")).status, 409)
        // a stand-in for Desktop's relay: the view-request arrives on the frontend topic `events`, the page answers by POST
        const relay = Deno.serve({ port: 0, onListen: () => {} }, async (request) => {
            const event = await request.json()
            if (new URL(request.url).pathname === "/desktop/frontend/lcm/events" && event.type === "view-request") {
                await pagePlumbing(
                    new Request(`http://app/api/views/${event.id}`, {
                        method: "POST",
                        body: JSON.stringify({ png: "iVBORw0KGgo=" }),
                    }),
                )
            }
            return Response.json({ ok: true })
        })
        Deno.env.set("DIMOS_APP", JSON.stringify({ name: "lcm", desktopUrl: `http://127.0.0.1:${relay.addr.port}` }))
        const page = (path: string) => pagePlumbing(new Request(`http://app/${path}`, { method: "POST" }))
        assertEquals((await (await page("api/pages/p1"))!.json()).ok, true)
        const view = (await call("GET", "api/view")).json
        assertEquals(view.image, { mimeType: "image/png", data: "iVBORw0KGgo=" })
        await page("api/pages/p1/bye")
        assertEquals((await call("GET", "api/view")).status, 409)
        Deno.env.delete("DIMOS_APP")
        await relay.shutdown()
    },
})

Deno.test("pickle: the plain data dimos publishes", () => {
    // python: pickle.dumps({...}) with nested dicts, lists, tuples, floats, big and negative ints, None, unicode
    const data =
        "gASV7AAAAAAAAAB9lCiMC2Nvb3JkaW5hdG9ylH2UKIwDcGlklEsBjAtjcHVfcGVyY2VudJRHQCkAAAAAAACMA3Bzc5RKAAAQAIwFYWxpdmWUiIwEbmFtZZSMAXiUjAhjaGlsZHJlbpRdlHWMB3dvcmtlcnOUXZR9lCiMCXdvcmtlcl9pZJRLAIwHbW9kdWxlc5RdlCiMAUGUjAFClGVoBoloBYoGAAAAAAABaARHAAAAAAAAAACMA25lZ5RK/f///4wDYmlnlIoJAAAAAAAAAADAjAF0lEsBSwKGlIwEbm9uZZROjAN1bmmUjAZow6lsbG+UdWF1Lg=="
    const value = unpickle(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))) as {
        coordinator: unknown
        workers: Record<string, unknown>[]
    }
    assertEquals(value.coordinator, { pid: 1, cpu_percent: 12.5, pss: 1048576, alive: true, name: "x", children: [] })
    const worker = value.workers[0]
    assertEquals(worker.modules, ["A", "B"])
    assertEquals(worker.pss, 2 ** 40)
    assertEquals(worker.neg, -3)
    assertEquals(worker.big, -(2 ** 70))
    assertEquals(worker.t, [1, 2])
    assertEquals(worker.none, null)
    assertEquals(worker.uni, "héllo")
})

Deno.test("agent.json lists every route", async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
})
