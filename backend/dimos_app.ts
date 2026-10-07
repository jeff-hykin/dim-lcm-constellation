// What dimOS Desktop tells this server at start: the DIMOS_APP env var, one JSON object and the whole interface
// (docs/apps.md in dimos-desktop).

export type DimosApp = {
    version: number | null
    name: string | null
    socket: string | null
    url: string | null
    path: string | null
    dataDir: string | null
    desktopUrl: string | null
    zenohGatewayUrl: string | null
    zenohConnect: string | null
    zenohNamespace: string | null
    zenohPrefix: string | null
    dimosDir: string | null
    dimosPython: string | null
    recordingsDir: string | null
}

const EMPTY: DimosApp = {
    version: null,
    name: null,
    socket: null,
    url: null,
    path: null,
    dataDir: null,
    desktopUrl: null,
    zenohGatewayUrl: null,
    zenohConnect: null,
    zenohNamespace: null,
    zenohPrefix: null,
    dimosDir: null,
    dimosPython: null,
    recordingsDir: null,
}

/** DIMOS_APP's fields; one it lacks (or all of them, run outside Desktop) is null. */
export function readDimosApp(): DimosApp {
    const json = Deno.env.get("DIMOS_APP")
    return { ...EMPTY, ...(json ? JSON.parse(json) : {}) }
}

/** DIMOS_APP, read once; the raw JSON is logged once so the App Store's log shows it. */
export const dimosApp: DimosApp = readDimosApp()
if (Deno.env.get("DIMOS_APP")) {
    console.error(`DIMOS_APP: ${Deno.env.get("DIMOS_APP")}`)
}
