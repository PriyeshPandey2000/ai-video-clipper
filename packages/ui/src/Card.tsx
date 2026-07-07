import React from "react"

interface CardProps {
  children: React.ReactNode
  className?: string
  onClick?: () => void
}

export function Card({ children, className = "", onClick }: CardProps): React.ReactElement {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-neutral-800 bg-neutral-900 p-4
        ${onClick ? "cursor-pointer hover:border-neutral-600 transition-colors" : ""}
        ${className}`}
    >
      {children}
    </div>
  )
}
