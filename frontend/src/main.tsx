import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { followDesktopTheme } from "./theme.ts"
import "./theme.css"
import "./app.css"

followDesktopTheme()
createRoot(document.getElementById("root")!).render(<App />)
