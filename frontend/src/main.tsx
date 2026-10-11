import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import { App } from "./App.tsx"
import "./app.css"

createRoot(document.getElementById("root")!).render(
    <AppProvider url={false}>
        <App />
    </AppProvider>,
)
