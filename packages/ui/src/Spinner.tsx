import React from "react"

interface SpinnerProps {
  size?: number
  className?: string
}

export function Spinner({ size = 16, className = "" }: SpinnerProps): React.ReactElement {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
