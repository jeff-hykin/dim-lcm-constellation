// Types for frontend_publish.js
export interface PublishOptions {
    contentType?: string
    ordered?: boolean
    app?: { name?: string | null; desktopUrl?: string | null }
    fetch?: typeof fetch
}
export type RelayAnswer = { ok: true; key: string; bytes: number } | null
export function publishFrontend(topic: string, payload: unknown, options?: PublishOptions): Promise<RelayAnswer>
export function stateChanged(key: string, version?: number, options?: PublishOptions): Promise<RelayAnswer>
