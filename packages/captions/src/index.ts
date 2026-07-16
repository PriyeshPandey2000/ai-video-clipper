import type { CaptionStyle } from "@video-editor/types"
import { buildCaptionAccentSet } from "@video-editor/utils"

export type { CaptionStyle } from "@video-editor/types"

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: "hormozi",
  accentColor: "#FFD700",
  textColor: "#FFFFFF",
  position: "bottom",
  size: "M",
  allCaps: true,
  showKeywords: true,
}

// &HAABBGGRR — alpha, blue, green, red
function hexToAssColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "")
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  const a = alpha.toString(16).padStart(2, "0").toUpperCase()
  return `&H${a}${b}${g}${r}`.toUpperCase()
}

function msToAssTime(ms: number): string {
  const cs = Math.floor(ms / 10)
  const centiseconds = cs % 100
  const totalSeconds = Math.floor(cs / 100)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`
}

function fontSizePx(size: "S" | "M" | "L"): number {
  return size === "S" ? 60 : size === "L" ? 100 : 80
}

function buildStyleBlock(style: CaptionStyle): string {
  const fs = fontSizePx(style.size)
  const alignment = style.position === "top" ? 8 : 2
  const primaryColor = hexToAssColor(style.textColor)
  const accentColor = hexToAssColor(style.accentColor)
  const boxColor = "&HCC000000"
  const blackOpaque = "&H00000000"

  if (style.preset === "hormozi") {
    // BorderStyle 3 = opaque box — one word per Dialogue line so box wraps tight around each word
    return `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat ExtraBold,${fs},${primaryColor},${primaryColor},${blackOpaque},${boxColor},-1,0,0,0,100,100,2,0,3,0,0,${alignment},20,20,80,1
Style: Accent,Montserrat ExtraBold,${fs},&H00000000,&H00000000,${blackOpaque},${accentColor},-1,0,0,0,100,100,2,0,3,0,0,${alignment},20,20,80,1`
  } else {
    // wordpop: thick outline, no box — white text pops on any background
    return `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat ExtraBold,${fs},${primaryColor},${primaryColor},&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,4,2,${alignment},40,40,80,1
Style: Accent,Montserrat ExtraBold,${fs},${accentColor},${accentColor},&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,4,2,${alignment},40,40,80,1`
  }
}

export function buildAssFile(
  wordRows: Array<{ text: string; startMs: number; endMs: number }>,
  style: CaptionStyle,
): string {
  if (wordRows.length === 0) return ""

  const keyIndices =
    style.preset === "hormozi" && style.showKeywords
      ? buildCaptionAccentSet(wordRows)
      : new Set<number>()

  const styleBlock = buildStyleBlock(style)

  const dialogueLines = wordRows.map((w, i) => {
    const raw = w.text
      .trim()
      .replace(/\\/g, "")
      .replace(/\{/g, "")
      .replace(/[\r\n]/g, " ")
    const cased = style.allCaps ? raw.toUpperCase() : raw
    // Shrink very long words inline
    const display =
      cased.replace(/\P{L}/gu, "").length > 12
        ? `{\\fs${Math.round(fontSizePx(style.size) * 0.7)}}${cased}`
        : cased
    const styleName = keyIndices.has(i) ? "Accent" : "Default"
    return `Dialogue: 0,${msToAssTime(w.startMs)},${msToAssTime(w.endMs)},${styleName},,0,0,0,,${display}`
  })

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

${styleBlock}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join("\n")}
`
}
