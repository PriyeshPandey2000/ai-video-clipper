import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ErrorBoundary } from "./ErrorBoundary"
import "./index.css"

window.addEventListener("error", (event) => {
  const stack = event.error instanceof Error ? event.error.stack : undefined
  void window.api.invoke("log:report-error", {
    message: event.message,
    source: "window.onerror",
    ...(stack ? { stack } : {}),
  })
})

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as unknown
  const stack = reason instanceof Error ? reason.stack : undefined
  void window.api.invoke("log:report-error", {
    message: reason instanceof Error ? reason.message : String(reason),
    source: "unhandledrejection",
    ...(stack ? { stack } : {}),
  })
})

const root = document.getElementById("root")!
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary label="Clipper">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
