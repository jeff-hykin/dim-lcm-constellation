// What dimOS Desktop tells this server at start: the DIMOS_APP env var, one JSON object (docs/apps.md in
// dimos-desktop). Desktops from before 2026-10-05 don't set it; their flags and env vars are the fallback.

export type DimosApp = {
    version: number
    name: string | null
    socket: string | null
    url: string | null
    path: string | null
    dataDir: string | null
    desktopUrl: string | null
    zenohWebUrl: string | null
    zenohConnect: string | null
    dimosDir: string | null
    dimosPython: string | null
    recordingsDir: string | null
}

function env(name: string): string | undefined {
    return Deno.env.get(name) || undefined
}

export function readDimosApp(args: string[] = Deno.args): DimosApp {
    const flag = (name: string) => {
        const index = args.indexOf(`--${name}`)
        return index === -1 ? undefined : args[index + 1]
    }
    const json = env("DIMOS_APP")
    const given: Partial<DimosApp> = json ? JSON.parse(json) : {}
    const name = given.name ?? env("DIMOS_APP_NAME") ?? null
    const desktopUrl = given.desktopUrl ?? flag("desktop-url") ?? env("DIMOS_DESKTOP_URL") ?? null
    const path = given.path ?? (name ? `/apps/${name}/` : null)
    return {
        version: given.version ?? 0,
        name,
        socket: given.socket ?? flag("socket") ?? env("DIMOS_APP_SOCKET") ?? null,
        url: given.url ?? (desktopUrl && path ? desktopUrl + path : null),
        path,
        dataDir: given.dataDir ?? env("DIMOS_APP_DATA") ?? null,
        desktopUrl,
        zenohWebUrl: given.zenohWebUrl ?? flag("zenoh-web-url") ?? env("ZENOH_WEB_URL") ?? null,
        zenohConnect: given.zenohConnect ?? flag("zenoh-connect") ?? env("ZENOH_CONNECT") ?? null,
        dimosDir: given.dimosDir ?? flag("dimos-dir") ?? env("DIMOS_DIR") ?? null,
        dimosPython: given.dimosPython ?? flag("dimos-python") ?? env("DIMOS_PYTHON") ?? null,
        recordingsDir: given.recordingsDir ?? env("DIMOS_RECORDINGS_DIR") ?? null,
    }
}

/** DIMOS_APP (else the older flags/env), read once; the raw JSON is logged once so the App Store's log shows it. */
export const dimosApp: DimosApp = readDimosApp()
if (env("DIMOS_APP")) {
    console.error(`DIMOS_APP: ${env("DIMOS_APP")}`)
}
