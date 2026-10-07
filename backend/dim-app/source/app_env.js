// What Desktop tells an app's server at start: the DIMOS_APP env var, one JSON object, the whole interface (Desktop's
// docs/apps.md).

const FIELDS = [
    "version",
    "name",
    "socket",
    "url",
    "path",
    "dataDir",
    "desktopUrl",
    "zenohGatewayUrl",
    "zenohConnect",
    "zenohNamespace",
    "zenohPrefix",
    "dimosDir",
    "dimosPython",
    "recordingsDir",
]

/**
 * `{ version, name, socket, url, path, dataDir, desktopUrl, zenohGatewayUrl, zenohConnect, zenohNamespace, zenohPrefix,
 * dimosDir, dimosPython, recordingsDir }` from DIMOS_APP; a field it doesn't have (or all of them, run outside
 * Desktop) is null.
 */
export function readDimosApp() {
    let json
    try {
        json = globalThis.Deno?.env.get("DIMOS_APP")
    } catch {
        json = undefined
    }
    return { ...Object.fromEntries(FIELDS.map((field) => [field, null])), ...(json ? JSON.parse(json) : {}) }
}
