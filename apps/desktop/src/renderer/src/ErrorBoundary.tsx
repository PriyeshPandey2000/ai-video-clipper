import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"

interface Props {
  label: string
  children: ReactNode
}

interface State {
  error: Error | null
}

// Scoped per panel (not one app-wide boundary) so a render crash in, say, the caption
// canvas doesn't blank the whole editor — the rest of the UI stays usable.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = info.componentStack ?? error.stack
    window.api
      .invoke("log:report-error", {
        message: error.message,
        source: this.props.label,
        ...(stack ? { stack } : {}),
      })
      .catch(() => {})
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 h-full p-6 text-center text-neutral-400">
          <AlertTriangle size={18} className="text-yellow-500" />
          <p className="text-sm">{this.props.label} hit an error and couldn't render.</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-xs text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
