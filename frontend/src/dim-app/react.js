// React bindings: useBackendState, snapshot + live backend state (backend_state.js); EmptyState and useAppInstalled
// (desktop.js). Imports "react" from the app.
//
//     import { useBackendState } from "./dim-app/react.js"
//     const [recordings, { loading, error, refresh }] = useBackendState("recordings") // GET api/state/recordings
//     const [library] = useBackendState("api/library", { key: "library" })            // re-GET on state/library events

import { createElement, useCallback, useEffect, useRef, useState } from "react"
import { watchBackendState } from "./backend_state.js"
import { appInstalled, emptyState } from "./desktop.js"

/**
 * @param {string} source a key ("recordings" → GET api/state/recordings) or an app-relative URL
 * @param {{ key?: string, url?: string, topic?: string, debounceMs?: number, initial?: any }} [options] read once, when
 *   `source` changes
 * @returns {[any, { loading: boolean, error: Error | null, version: number | null, refresh: () => Promise<void> }]}
 */
export function useBackendState(source, options = {}) {
    const [snapshot, setSnapshot] = useState({ data: options.initial, loading: true, error: null, version: null })
    const watch = useRef(null)
    const optionsRef = useRef(options)
    optionsRef.current = options
    useEffect(() => {
        if (!source) {
            return
        }
        const { initial: _initial, ...watchOptions } = optionsRef.current
        const watcher = watchBackendState(source, setSnapshot, watchOptions)
        watch.current = watcher
        return () => {
            watcher.stop()
            if (watch.current === watcher) {
                watch.current = null
            }
        }
    }, [source])
    const refresh = useCallback(() => watch.current?.refresh() ?? Promise.resolve(), [])
    return [snapshot.data, { loading: snapshot.loading, error: snapshot.error, version: snapshot.version, refresh }]
}

/**
 * desktop.js's `emptyState` as a component: a first-run / empty / error message with next-step buttons. `layer`
 * centers it over the whole view (a canvas, a 3D scene), above Desktop's dock.
 * @param {Parameters<typeof emptyState>[0] & { layer?: boolean, style?: object }} props
 */
export function EmptyState(props) {
    const ref = useRef(null)
    useEffect(() => {
        ref.current?.replaceChildren(emptyState(props))
    })
    return createElement("div", {
        ref,
        className: props.layer ? "dim-empty-layer" : "dim-empty-host",
        style: props.style,
    })
}

/** Whether app `id` is installed in Desktop (null until known); re-checks when Desktop's app list changes. */
export function useAppInstalled(id) {
    const [installed, setInstalled] = useState(null)
    useEffect(() => {
        let live = true
        appInstalled(id).then((value) => live && setInstalled(value))
        return () => {
            live = false
        }
    }, [id])
    return installed
}
