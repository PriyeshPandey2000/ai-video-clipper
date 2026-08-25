// Tracks whether a long-running job (transcription, export) is in flight, so the updater knows
// it's not safe to auto-restart the app — killing whisper-cli/ffmpeg mid-job loses the user's
// work with no resume. Project status in the DB only covers transcription, not exports, so this
// is a separate, deliberately dumb counter rather than a DB query.
let activeCount = 0

export function beginActivity(): void {
  activeCount++
}

export function endActivity(): void {
  activeCount = Math.max(0, activeCount - 1)
}

export function isBusy(): boolean {
  return activeCount > 0
}
