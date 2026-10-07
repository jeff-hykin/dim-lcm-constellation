// What Desktop tells an app's server at start: the DIMOS_APP env var, a JSON object (Desktop's docs/apps.md), else
// (Desktops from before 2026-10-05) the same values from the old flags and env vars.

function readEnv(name) {
    try {
        return globalThis.Deno?.env.get(name) || undefined
    } catch {
        return undefined
    }
}

/**
 * `{ version, name, socket, url, path, dataDir, desktopUrl, zenohGatewayUrl, zenohWebUrl (deprecated), zenohConnect, dimosDir, dimosPython,
 * recordingsDir, zenohNamespace, zenohPrefix }`; a field the Desktop didn't give is null.
 * @param {string[]} [args] the server's argv (the old flags)
 */
export function readDimosApp(args = globalThis.Deno?.args ?? []) {
    const json = readEnv("DIMOS_APP")
    if (json) {
        return { ...fallback([]), ...JSON.parse(json) }
    }
    return fallback(args)
}

function fallback(args) {
    const flag = (name) => {
        const index = args.indexOf(`--${name}`)
        return index === -1 ? undefined : args[index + 1]
    }
    const name = readEnv("DIMOS_APP_NAME") ?? null
    const desktopUrl = flag("desktop-url") ?? readEnv("DIMOS_DESKTOP_URL") ??
        null
    const path = name ? `/apps/${name}/` : null
    return {
        version: 0,
        name,
        socket: flag("socket") ?? readEnv("DIMOS_APP_SOCKET") ?? null,
        url: desktopUrl && path ? desktopUrl + path : null,
        path,
        dataDir: readEnv("DIMOS_APP_DATA") ?? null,
        desktopUrl,
        // Desktops that only pass flags/env serve zenoh-web 0.4, which this client doesn't speak
        zenohGatewayUrl: null,
        zenohWebUrl: flag("zenoh-web-url") ?? readEnv("ZENOH_WEB_URL") ?? null,
        zenohConnect: flag("zenoh-connect") ?? readEnv("ZENOH_CONNECT") ?? null,
        dimosDir: flag("dimos-dir") ?? readEnv("DIMOS_DIR") ?? null,
        dimosPython: flag("dimos-python") ?? readEnv("DIMOS_PYTHON") ?? null,
        recordingsDir: readEnv("DIMOS_RECORDINGS_DIR") ?? null,
        zenohNamespace: null,
        zenohPrefix: null,
    }
}
