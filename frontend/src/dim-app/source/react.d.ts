// Types for react.js
import type { BackendStateOptions } from "./backend_state.d.ts"
export function useBackendState<T = unknown>(
    source: string | null | undefined,
    options?: BackendStateOptions & { initial?: T },
): [T | undefined, { loading: boolean; error: Error | null; version: number | null; refresh: () => Promise<void> }]
import type { ReactElement } from "react"
import type { EmptyStateOptions } from "./desktop.d.ts"
export function EmptyState(
    props: EmptyStateOptions & { layer?: boolean; style?: Record<string, string | number> },
): ReactElement
export function useAppInstalled(id: string): boolean | null
