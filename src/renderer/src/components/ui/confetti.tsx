import React from 'react'

const CONFETTI_COLORS = ['#10b981', '#f59e0b', '#6366f1', '#ef4444', '#06b6d4']

/** Full-window confetti burst, shown when the board is cleared. */
export function ConfettiOverlay(): React.JSX.Element {
  const pieces = Array.from({ length: 36 })
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {pieces.map((_, i) => {
        const left = Math.random() * 100
        const delay = Math.random() * 0.5
        const duration = 2.5 + Math.random() * 1.2
        const size = 6 + Math.random() * 6
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
        return (
          <span
            key={i}
            className="confetti-piece absolute rounded-sm"
            style={{
              left: `${left}%`,
              top: '-10px',
              width: `${size}px`,
              height: `${size * 0.4}px`,
              backgroundColor: color,
              transform: 'translateY(0)',
              animation: `confetti-fall ${duration}s ease-in forwards`,
              animationDelay: `${delay}s`
            }}
          />
        )
      })}
    </div>
  )
}
