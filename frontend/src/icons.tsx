// dimOS shared line icons (24-unit grid, stroke = currentColor), the ones this app uses.
const PATHS = {
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    "chevron-down": "m6 9 6 6 6-6",
    "chevron-right": "m9 6 6 6-6 6",
    pin: "M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Zm3 10v7",
    pause: "M8 5v14M16 5v14",
    play: "M7 4v16l13-8L7 4Z",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4",
}
export type IconName = keyof typeof PATHS

/** The SVG markup, for the imperatively built graph nodes. */
export function iconSvg(name: IconName, size = 18): string {
    return `<svg class="dim-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${
        PATHS[name]
    }"/></svg>`
}

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
    return (
        <i className={className}>
            <svg className="dim-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
                <path d={PATHS[name]} />
            </svg>
        </i>
    )
}
