import React from "react"

interface ProgressProps {
  value: number // 0–1
  className?: string
}

export function Progress({ value, className = "" }: ProgressProps): React.ReactElement {
  return (
    <div className={`h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden ${className}`}>
      <div
        className="h-full rounded-full bg-violet-500 transition-all duration-300"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  )
}
