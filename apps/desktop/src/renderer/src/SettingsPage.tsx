import { useState, useEffect, useCallback } from "react"
import type { ModelInfo, WhisperModel } from "@video-editor/types"
import { Spinner } from "@video-editor/ui"
import { ArrowLeft, Trash2 } from "lucide-react"

const MODEL_LABELS: Record<WhisperModel, string> = {
  tiny: "Tiny",
  base: "Base",
  small: "Small",
  medium: "Medium",
  large: "Large",
}

const MODEL_DISPLAY_SIZE: Record<WhisperModel, string> = {
  tiny: "~75 MB",
  base: "~142 MB",
  small: "~466 MB",
  medium: "~1.5 GB",
  large: "~3.1 GB",
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`
  return `${(bytes / 1_000).toFixed(0)} KB`
}

interface SettingsPageProps {
  onBack: () => void
  onModelsChanged: () => void
}

export function SettingsPage({ onBack, onModelsChanged }: SettingsPageProps): React.ReactElement {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [deleting, setDeleting] = useState<WhisperModel | null>(null)

  const loadModels = useCallback(async () => {
    const list = await window.api.invoke("models:list")
    setModels(list)
  }, [])

  useEffect(() => {
    loadModels().catch(() => {})
  }, [loadModels])

  const handleDelete = useCallback(
    async (model: WhisperModel) => {
      setDeleting(model)
      try {
        await window.api.invoke("models:delete", { model })
        await loadModels()
        onModelsChanged()
      } catch (err) {
        console.error("Failed to delete model:", err)
      } finally {
        setDeleting(null)
      }
    },
    [loadModels, onModelsChanged],
  )

  const totalOnDisk = models?.reduce((sum, m) => sum + (m.sizeOnDisk ?? 0), 0) ?? 0

  return (
    <div className="flex flex-col h-full bg-neutral-950 text-neutral-100">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-800">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
        >
          <ArrowLeft size={13} />
          Back
        </button>
        <h1 className="text-sm font-semibold text-neutral-100">Settings</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-10">
          {/* Models section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-neutral-100">Whisper Models</h2>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Models download automatically when you transcribe. Delete unused ones to free
                  space.
                </p>
              </div>
              {totalOnDisk > 0 && (
                <span className="text-xs text-neutral-500 shrink-0">
                  {formatBytes(totalOnDisk)} used
                </span>
              )}
            </div>

            {models === null ? (
              <div className="flex justify-center py-8">
                <Spinner size={18} />
              </div>
            ) : (
              <div className="rounded-xl border border-neutral-800 overflow-hidden">
                {models.map((m, i) => (
                  <div
                    key={m.model}
                    className={`flex items-center gap-4 px-4 py-3 ${
                      i < models.length - 1 ? "border-b border-neutral-800" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          m.downloaded ? "bg-green-500" : "bg-neutral-600"
                        }`}
                      />
                      <span className="text-sm font-medium text-neutral-200 w-16 shrink-0">
                        {MODEL_LABELS[m.model]}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {m.sizeOnDisk ? formatBytes(m.sizeOnDisk) : MODEL_DISPLAY_SIZE[m.model]}
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span
                        className={`text-xs ${
                          m.downloaded ? "text-green-500" : "text-neutral-600"
                        }`}
                      >
                        {m.downloaded ? "On disk" : "Not downloaded"}
                      </span>
                      {m.downloaded && (
                        <button
                          onClick={() => handleDelete(m.model)}
                          disabled={deleting === m.model}
                          title={`Delete ${MODEL_LABELS[m.model]} model`}
                          className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-950/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                        >
                          {deleting === m.model ? <Spinner size={12} /> : <Trash2 size={13} />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
