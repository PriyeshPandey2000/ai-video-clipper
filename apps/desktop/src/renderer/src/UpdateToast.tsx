import { useEffect, useState } from "react"
import type { UpdaterState } from "@video-editor/types"
import { Button } from "@video-editor/ui"
import { Progress } from "@video-editor/ui"
import { Download, X, RefreshCw, AlertTriangle } from "lucide-react"

type UpdateState = UpdaterState

export function UpdateToast(): React.ReactElement | null {
  const [state, setState] = useState<UpdateState>({ kind: "idle" })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const unsubAvailable = window.api.on("updater:available", ({ version }) => {
      setDismissed(false)
      setState({ kind: "available", version })
    })
    const unsubProgress = window.api.on("updater:progress", ({ percent }) => {
      setState({ kind: "downloading", percent })
    })
    const unsubDownloaded = window.api.on("updater:downloaded", ({ readyToInstall }) => {
      setState({ kind: "downloaded", readyToInstall })
    })
    const unsubError = window.api.on("updater:error", ({ message }) => {
      setState({ kind: "error", message })
    })

    // Backfill: checkForUpdates() runs 5s after launch and webContents.send() silently drops
    // an event if nothing's listening yet — if this component mounts late (slow renderer boot)
    // it could otherwise miss "available" for the rest of the session. Only apply if a live
    // event above hasn't already moved state past idle while this was in flight.
    window.api
      .invoke("updater:get-state")
      .then((backfilled) => {
        setState((current) => (current.kind === "idle" ? backfilled : current))
      })
      .catch(() => {})

    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
      unsubError()
    }
  }, [])

  if (dismissed || state.kind === "idle") return null

  return (
    <div className="fixed top-4 right-4 z-50 w-80 rounded-xl border border-neutral-800 bg-neutral-900/95 backdrop-blur-sm shadow-2xl overflow-hidden">
      <div className="p-4">
        {state.kind === "available" && (
          <>
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 shrink-0 rounded-full bg-violet-500/15 p-1.5">
                <Download size={14} className="text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-100">Update available</p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Version {state.version} is ready to download.
                </p>
              </div>
              <button
                onClick={() => setDismissed(true)}
                className="shrink-0 text-neutral-600 hover:text-neutral-300 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
            <Button
              size="sm"
              className="w-full mt-3"
              onClick={() => void window.api.invoke("updater:download")}
            >
              Update
            </Button>
          </>
        )}

        {state.kind === "downloading" && (
          <>
            <div className="flex items-center gap-2.5">
              <div className="shrink-0 rounded-full bg-violet-500/15 p-1.5">
                <Download size={14} className="text-violet-400" />
              </div>
              <p className="text-sm font-medium text-neutral-100">
                Downloading update… {state.percent}%
              </p>
            </div>
            <Progress value={state.percent / 100} className="mt-3" />
          </>
        )}

        {state.kind === "downloaded" && (
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0 rounded-full bg-green-500/15 p-1.5">
              <RefreshCw size={14} className="text-green-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-neutral-100">
                {state.readyToInstall ? "Restarting to finish update…" : "Update ready"}
              </p>
              <p className="text-xs text-neutral-500 mt-0.5">
                {state.readyToInstall
                  ? "Clipper will restart in a few seconds."
                  : "Will install automatically the next time you close Clipper."}
              </p>
            </div>
            {!state.readyToInstall && (
              <button
                onClick={() => setDismissed(true)}
                className="shrink-0 text-neutral-600 hover:text-neutral-300 transition-colors cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0 rounded-full bg-red-500/15 p-1.5">
              <AlertTriangle size={14} className="text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-neutral-100">Update failed</p>
              <p className="text-xs text-neutral-500 mt-0.5">{state.message}</p>
            </div>
            <button
              onClick={() => setDismissed(true)}
              className="shrink-0 text-neutral-600 hover:text-neutral-300 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
