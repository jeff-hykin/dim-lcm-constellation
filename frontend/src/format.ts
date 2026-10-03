// Colors and number formatting shared by the graph and the panels.

// Node accent colors are *theme variable names* (e.g. "--warn") applied inline as `--node-accent: var(--warn)`, so
// the browser resolves them live and the whole graph re-themes on light/dark flips.
const TYPE_VARS: Record<string, string> = {
    Image: "--warn",
    CompressedImage: "--warn",
    CameraInfo: "--warn",
    PointCloud2: "--violet",
    LaserScan: "--violet",
    OccupancyGrid: "--cat-1",
    Path: "--cat-1",
    Odometry: "--info",
    PoseStamped: "--info",
    Twist: "--info",
    TFMessage: "--ok",
    Bool: "--cat-2",
    String: "--cat-2",
}
const PKG_VARS: Record<string, string> = {
    sensor_msgs: "--warn",
    geometry_msgs: "--info",
    nav_msgs: "--cat-1",
    tf2_msgs: "--ok",
    vision_msgs: "--violet",
    std_msgs: "--cat-2",
}
const PALETTE = ["--info", "--warn", "--cat-1", "--violet", "--ok", "--cat-2", "--cat-3", "--cat-4"]

const hashVar = (key: string) => PALETTE[[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]

/** A channel's display base and message type: LCM after `#`, Zenoh as the last key segment. */
export function channelType(channel: string): { base: string; msgType: string } {
    if (channel.includes("#")) {
        const [base, msgType] = channel.split("#")
        return { base, msgType: msgType ?? "" }
    }
    const segments = channel.split("/")
    const last = segments[segments.length - 1]
    if (segments.length > 1 && last.includes(".")) {
        return { base: segments.slice(0, -1).join("/"), msgType: last }
    }
    return { base: channel, msgType: "" }
}

/** The bare name a live channel and a blueprint topic share (`/camera_info#sensor_msgs.CameraInfo` → `camera_info`). */
export function normBase(channel: string): string {
    const segments = channelType(channel).base.replace(/^\/+/, "").split("/")
    return segments[segments.length - 1]
}

export function accentVar(channel: string): string {
    const { msgType } = channelType(channel)
    if (msgType) {
        const msg = msgType.split(".").pop()!
        if (TYPE_VARS[msg]) {
            return TYPE_VARS[msg]
        }
        const pkg = msgType.split(".")[0]
        if (PKG_VARS[pkg]) {
            return PKG_VARS[pkg]
        }
    }
    if (channel.startsWith("/rpc") || channel.startsWith("rpc")) {
        return "--cat-1"
    }
    return hashVar(channel)
}

/** Blueprint stream types are bare or dotted ("PointCloud2", "nav_msgs.Odometry"). */
export function accentForType(type: string, topicName: string): string {
    const msg = (type || "").split(".").pop()!
    if (TYPE_VARS[msg]) {
        return TYPE_VARS[msg]
    }
    const pkg = (type || "").includes(".") ? type.split(".")[0] : ""
    if (PKG_VARS[pkg]) {
        return PKG_VARS[pkg]
    }
    return hashVar(topicName || type || "")
}

/** A rare topic reads 0 Hz on a 5 s window, so say how long ago its last message landed. */
export function agoText(msAgo: number): string {
    const s = msAgo / 1000
    if (s < 1.5) {
        return "just now"
    }
    if (s < 60) {
        return `${Math.round(s)}s ago`
    }
    if (s < 3600) {
        return `${Math.round(s / 60)}m ago`
    }
    return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h ago`
}

export function human(bytes: number): string {
    const units = ["B", "KiB", "MiB", "GiB"]
    let i = 0
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024
        i++
    }
    return bytes.toFixed(i ? 1 : 0) + " " + units[i]
}

/** bytes/s → bits/s (bps/Kbps/Mbps/Gbps, decimal) */
export function humanBits(bytesPerSec: number): string {
    let bits = bytesPerSec * 8
    const units = ["bps", "Kbps", "Mbps", "Gbps"]
    let i = 0
    while (bits >= 1000 && i < units.length - 1) {
        bits /= 1000
        i++
    }
    return bits.toFixed(bits >= 100 || i === 0 ? 0 : 1) + " " + units[i]
}

export function humanSecs(value: unknown): string {
    const s = Number(value) || 0
    if (s < 60) {
        return s.toFixed(s < 10 ? 2 : 1) + "s"
    }
    if (s < 3600) {
        return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s"
    }
    return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m"
}

/** value → cool→hot color (blue = low, red = high), skipping the green band. */
export function heatColor(fraction: number): string {
    const f = Math.max(0, Math.min(1, fraction))
    const lightness = document.body.classList.contains("dark") ? 62 : 46
    return `hsl(${(210 + 150 * f).toFixed(0)} 85% ${lightness}%)`
}

/** log-scale 0..1 against a max (rates and memory span orders of magnitude) */
export function heatFracLog(value: number, max: number): number {
    if (!(max > 0) || !(value > 0)) {
        return 0
    }
    return Math.log1p(value) / Math.log1p(max)
}
