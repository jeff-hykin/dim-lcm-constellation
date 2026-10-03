// Follow dimOS Desktop's light/dark choice: the shell writes localStorage "dimos.themeChoice" ("light" | "dark",
// missing = dark); apps are same-origin iframes, so read it once and again on every `storage` event.
const KEY = "dimos.themeChoice"

function apply() {
    let light = false
    try {
        light = localStorage.getItem(KEY) === "light"
    } catch {
        // storage blocked: dark
    }
    document.documentElement.style.colorScheme = light ? "light" : "dark"
    document.body.classList.add("science")
    document.body.classList.toggle("dark", !light)
    globalThis.dispatchEvent(new CustomEvent("dim-theme", { detail: { dark: !light } }))
}

export function followDesktopTheme() {
    apply()
    globalThis.addEventListener("storage", (event) => {
        if (event.key === KEY || event.key === null) {
            apply()
        }
    })
}
