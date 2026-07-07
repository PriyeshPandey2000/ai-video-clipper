import React from "react"

type Color = "violet" | "green" | "yellow" | "red" | "neutral"

const colorClasses: Record<Color, string> = {
  violet: "bg-violet-500/20 text-violet-300",
  green: "bg-green-500/20 text-green-300",
  yellow: "bg-yellow-500/20 text-yellow-300",
  red: "bg-red-500/20 text-red-300",
  neutral: "bg-neutral-700 text-neutral-300",
}

interface BadgeProps {
  children: React.ReactNode
  color?: Color
  className?: string
}

export function Badge({
  children,
  color = "neutral",
  className = "",
}: BadgeProps): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClasses[color]} ${className}`}
    >
      {children}
    </span>
  )
}
