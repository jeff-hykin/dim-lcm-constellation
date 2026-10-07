import { assertEquals } from "@std/assert"
import { readDimosApp } from "./dimos_app.ts"

Deno.test("DIMOS_APP is the whole interface: its fields, null for one it lacks or without it", () => {
    const before = Deno.env.get("DIMOS_APP")
    try {
        Deno.env.set(
            "DIMOS_APP",
            JSON.stringify({
                version: 2,
                name: "b",
                socket: "/s/b.sock",
                url: "http://127.0.0.1:7341/apps/b/",
                path: "/apps/b/",
                dataDir: "/d/b",
                zenohGatewayUrl: "http://127.0.0.1:7341/zenoh-gateway",
            }),
        )
        const app = readDimosApp()
        assertEquals([app.version, app.name, app.socket, app.url, app.path, app.dataDir], [
            2,
            "b",
            "/s/b.sock",
            "http://127.0.0.1:7341/apps/b/",
            "/apps/b/",
            "/d/b",
        ])
        assertEquals([app.zenohGatewayUrl, app.desktopUrl], ["http://127.0.0.1:7341/zenoh-gateway", null])
        Deno.env.delete("DIMOS_APP")
        assertEquals(readDimosApp().socket, null)
    } finally {
        before === undefined ? Deno.env.delete("DIMOS_APP") : Deno.env.set("DIMOS_APP", before)
    }
})
