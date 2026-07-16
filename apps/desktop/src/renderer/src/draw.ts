import type { CaptionStyle } from "@video-editor/types"

export type CaptionPreset = "hormozi" | "wordpop" | "none"

const ACCENT_GROUP = 4
export function buildCaptionAccentSet(words: Array<{ text: string }>): Set<number> {
  const accents = new Set<number>()
  for (let i = 0; i < words.length; i += ACCENT_GROUP) {
    let bestIdx = -1
    let bestLen = 4
    words.slice(i, i + ACCENT_GROUP).forEach((w, j) => {
      const len = w.text.replace(/\P{L}/gu, "").length
      if (len > bestLen) {
        bestLen = len
        bestIdx = j
      }
    })
    if (bestIdx >= 0) accents.add(i + bestIdx)
  }
  return accents
}

export interface DrawWord {
  text: string
  isAccent: boolean
}

function fontSizePx(size: "S" | "M" | "L", canvasHeight: number): number {
  const base = size === "S" ? 60 : size === "L" ? 100 : 80
  return Math.round(base * (canvasHeight / 1080))
}

// High-contrast text color against a given background hex
function contrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // Luminance formula
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : "#ffffff"
}

export function drawCaptionFrame(
  ctx: CanvasRenderingContext2D,
  word: DrawWord | null,
  style: CaptionStyle,
  canvasWidth: number,
  canvasHeight: number,
  wordScale = 1,
): void {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  if (!word || style.preset === "none") return

  const fs = fontSizePx(style.size, canvasHeight)
  ctx.font = `900 ${fs}px "Montserrat ExtraBold", "Arial Black", system-ui`
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"

  const rawText = word.text.replace(/[.,!?;:]+$/, "")
  const text = style.allCaps ? rawText.toUpperCase() : rawText

  const metrics = ctx.measureText(text)
  const textW = metrics.width
  const ascent = metrics.actualBoundingBoxAscent
  const descent = metrics.actualBoundingBoxDescent
  const textH = ascent + descent

  const marginV = canvasHeight * 0.07
  const baselineY = style.position === "top" ? marginV + ascent : canvasHeight - marginV - descent

  // Scale transform anchored to word center
  ctx.save()
  if (wordScale !== 1) {
    const cx = canvasWidth / 2
    const cy = baselineY - (ascent - descent) / 2
    ctx.translate(cx, cy)
    ctx.scale(wordScale, wordScale)
    ctx.translate(-cx, -cy)
  }

  if (style.preset === "hormozi") {
    const padX = fs * 0.35
    const padY = fs * 0.22
    const boxFill = word.isAccent ? style.accentColor : "rgba(0,0,0,0.85)"
    // Auto-contrast text: white text on dark box, black text on bright accent box
    const textFill = word.isAccent ? contrastColor(style.accentColor) : style.textColor

    ctx.fillStyle = boxFill
    ctx.fillRect(
      canvasWidth / 2 - textW / 2 - padX,
      baselineY - ascent - padY,
      textW + padX * 2,
      textH + padY * 2,
    )
    ctx.fillStyle = textFill
    ctx.fillText(text, canvasWidth / 2, baselineY)
  } else {
    // wordpop: thick outline, colored fill
    const textFill = word.isAccent ? style.accentColor : style.textColor
    ctx.strokeStyle = contrastColor(textFill)
    ctx.lineWidth = Math.max(1.5, fs * 0.05)
    ctx.lineJoin = "round"
    ctx.strokeText(text, canvasWidth / 2, baselineY)
    ctx.fillStyle = textFill
    ctx.fillText(text, canvasWidth / 2, baselineY)
  }

  ctx.restore()
}

// Two-word thumbnail: "YOUR" (default) + "WORD" (accent) — same visual logic as drawCaptionFrame
export function drawPreviewCard(
  ctx: CanvasRenderingContext2D,
  preset: CaptionPreset,
  accentColor: string,
  textColor: string,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h)

  if (preset === "none") {
    ctx.font = `600 9px "Montserrat ExtraBold", system-ui`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = "rgba(255,255,255,0.35)"
    ctx.fillText("line by line", w / 2, h / 2 - 7)
    ctx.fillText("subtitles", w / 2, h / 2 + 7)
    return
  }

  const fontSize = 15
  ctx.font = `900 ${fontSize}px "Montserrat ExtraBold", "Arial Black", system-ui`
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"

  const words = [
    { text: "YOUR", isAccent: false },
    { text: "WORD", isAccent: true },
  ]
  const gap = 5
  const padX = fontSize * 0.28
  const padY = fontSize * 0.16

  const measured = words.map((word) => ({ ...word, m: ctx.measureText(word.text) }))
  const firstM = measured[0]!.m
  const ascent = firstM.actualBoundingBoxAscent || fontSize * 0.75
  const descent = firstM.actualBoundingBoxDescent || fontSize * 0.2
  const textH = ascent + descent
  const baselineY = h / 2 + (ascent - descent) / 2

  if (preset === "hormozi") {
    const totalW =
      measured.reduce((s, { m }) => s + m.width + padX * 2, 0) + gap * (measured.length - 1)
    let x = w / 2 - totalW / 2
    for (const { text, isAccent, m } of measured) {
      ctx.fillStyle = isAccent ? accentColor : "rgba(0,0,0,0.85)"
      ctx.fillRect(x, baselineY - ascent - padY, m.width + padX * 2, textH + padY * 2)
      ctx.fillStyle = isAccent ? contrastColor(accentColor) : textColor
      ctx.fillText(text, x + padX, baselineY)
      x += m.width + padX * 2 + gap
    }
  } else {
    const totalW = measured.reduce((s, { m }) => s + m.width, 0) + gap * (measured.length - 1)
    let x = w / 2 - totalW / 2
    for (const { text, isAccent, m } of measured) {
      const fill = isAccent ? accentColor : textColor
      ctx.strokeStyle = contrastColor(fill)
      ctx.lineWidth = Math.max(1, fontSize * 0.05)
      ctx.lineJoin = "round"
      ctx.strokeText(text, x, baselineY)
      ctx.fillStyle = fill
      ctx.fillText(text, x, baselineY)
      x += m.width + gap
    }
  }
}
