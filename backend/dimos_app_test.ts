import { assertEquals } from "@std/assert"
import { readDimosApp } from "./dimos_app.ts"

Deno.test("DIMOS_APP wins over the older flags; without it, the flags", () => {
    const before = Deno.env.get("DIMOS_APP")
    try {
        Deno.env.set(
            "DIMOS_APP",
            JSON.stringify({
                version: 1,
                name: "b",
                socket: "/s/b.sock",
                url: "http://127.0.0.1:7341/apps/b/",
                path: "/apps/b/",
                dataDir: "/d/b",
            }),
        )
        const app = readDimosApp(["--socket", "/old.sock", "--desktop-url", "http://127.0.0.1:7341"])
        assertEquals([app.version, app.name, app.socket, app.url, app.path, app.dataDir], [
            1,
            "b",
            "/s/b.sock",
            "http://127.0.0.1:7341/apps/b/",
            "/apps/b/",
            "/d/b",
        ])
        assertEquals(app.desktopUrl, "http://127.0.0.1:7341")
        Deno.env.delete("DIMOS_APP")
        const old = readDimosApp(["--socket", "/old.sock", "--zenoh-connect", ""])
        assertEquals([old.version, old.socket, old.zenohConnect], [0, "/old.sock", ""])
    } finally {
        before === undefined ? Deno.env.delete("DIMOS_APP") : Deno.env.set("DIMOS_APP", before)
    }
})
