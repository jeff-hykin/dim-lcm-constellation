// Types for backend_state.js
import type { AppZenoh } from "./zenoh.d.ts"
export interface BackendStateSnapshot<T = unknown> {
    data: T | undefined
    loading: boolean
    error: Error | null
    version: number | null
}
export interface BackendStateOptions {
    key?: string
    url?: string
    topic?: string
    debounceMs?: number
    zenoh?: AppZenoh
    fetch?: typeof fetch
    href?: string
    parse?: (response: Response) => Promise<unknown>
    init?: RequestInit
}
export function resolveSource(
    source: string,
    options?: BackendStateOptions,
): { url: string; key: string; topic: string }
export function watchBackendState<T = unknown>(
    source: string,
    onChange: (snapshot: BackendStateSnapshot<T>) => void,
    options?: BackendStateOptions,
): { refresh(): Promise<void>; stop(): void }
