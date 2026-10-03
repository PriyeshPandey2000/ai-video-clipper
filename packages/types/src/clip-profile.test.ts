import { describe, it, expect } from "vitest"
import {
  CLIP_PROFILE_DISPLAY,
  CLIP_PROFILE_IDS,
  describeClipProfile,
  type VideoAnalysis,
} from "./index"

function analysis(overrides: Partial<VideoAnalysis> = {}): VideoAnalysis {
  return {
    profile: "conversation",
    confidence: "high",
    summary: "Two founders talk pricing.",
    speakers: [{ role: "host" }, { role: "guest" }],
    mainTopics: ["pricing"],
    fallback: false,
    ...overrides,
  }
}

describe("CLIP_PROFILE_DISPLAY", () => {
  it("has a label and a one-line description for every profile", () => {
    for (const id of CLIP_PROFILE_IDS) {
      expect(CLIP_PROFILE_DISPLAY[id].label.length).toBeGreaterThan(0)
      expect(CLIP_PROFILE_DISPLAY[id].lookingFor.length).toBeGreaterThan(0)
    }
  })
})

describe("describeClipProfile", () => {
  it("says nothing was analysed yet, and offers no effective profile", () => {
    const v = describeClipProfile({ analysis: null, override: null })
    expect(v.state).toBe("none")
    expect(v.effective).toBeNull()
    expect(v.lookingFor).toBeNull()
    expect(v.headline).toMatch(/not analysed/i)
  })

  it("shows a real detection with its confidence", () => {
    const v = describeClipProfile({ analysis: analysis(), override: null })
    expect(v.state).toBe("detected")
    expect(v.effective).toBe("conversation")
    expect(v.headline).toBe("Detected: Conversation (high confidence)")
    expect(v.lookingFor).toBe(CLIP_PROFILE_DISPLAY.conversation.lookingFor)
    expect(v.lowConfidence).toBe(false)
  })

  it("never presents the documented fallback as a detection", () => {
    const v = describeClipProfile({
      analysis: analysis({ profile: "solo_opinion", confidence: "low", fallback: true }),
      override: null,
    })
    expect(v.state).toBe("fallback")
    expect(v.headline).not.toMatch(/detected/i)
    expect(v.headline).toMatch(/Couldn't tell/)
    // The fallback is already flagged by its own state, so it is not also reported as "unsure".
    expect(v.lowConfidence).toBe(false)
  })

  it("flags a low-confidence detection the user has not overridden", () => {
    const v = describeClipProfile({ analysis: analysis({ confidence: "low" }), override: null })
    expect(v.lowConfidence).toBe(true)
  })

  it("puts the user's choice first and keeps what was detected visible", () => {
    const v = describeClipProfile({
      analysis: analysis({ profile: "educational", confidence: "medium" }),
      override: "comedy",
    })
    expect(v.state).toBe("override")
    expect(v.effective).toBe("comedy")
    expect(v.headline).toBe("You chose: Comedy (detected: Educational, medium confidence)")
    expect(v.lookingFor).toBe(CLIP_PROFILE_DISPLAY.comedy.lookingFor)
    expect(v.lowConfidence).toBe(false)
  })

  it("does not quote a fallback as the thing that was 'detected' next to an override", () => {
    const v = describeClipProfile({
      analysis: analysis({ fallback: true, confidence: "low" }),
      override: "story",
    })
    expect(v.headline).toBe("You chose: Story")
  })

  it("accepts an override before any analysis exists", () => {
    const v = describeClipProfile({ analysis: null, override: "story" })
    expect(v.state).toBe("override")
    expect(v.headline).toBe("You chose: Story")
  })

  it("warns about visual videos whether detected or chosen", () => {
    expect(
      describeClipProfile({ analysis: analysis({ profile: "visual" }), override: null })
        .visualWarning,
    ).toBe(true)
    expect(describeClipProfile({ analysis: null, override: "visual" }).visualWarning).toBe(true)
    expect(describeClipProfile({ analysis: analysis(), override: null }).visualWarning).toBe(false)
  })

  it("shows the secondary profile as a hint for a mixed video, only for a real detection", () => {
    const mixed = describeClipProfile({
      analysis: analysis({ secondaryProfile: "educational" }),
      override: null,
    })
    expect(mixed.alsoLooksLike).toBe("Educational")
    const chosen = describeClipProfile({
      analysis: analysis({ secondaryProfile: "educational" }),
      override: "comedy",
    })
    expect(chosen.alsoLooksLike).toBeNull()
  })
})
