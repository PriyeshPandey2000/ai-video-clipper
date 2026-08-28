#!/usr/bin/env node
// electron-builder writes latest-mac.yml with the sha512/size of the .zip it just built — but
// notarize-check.sh rebuilds that .zip afterward (ditto re-archiving the now-stapled .app
// produces different bytes), so the manifest's checksum goes stale. electron-updater verifies
// the downloaded file's hash against this manifest and rejects it on mismatch, which would fail
// every single update. Run this after the rebuild to patch the manifest back to reality.
//
// Usage: node fix-update-manifest.js <path-to-rebuilt.zip> <path-to-latest-mac.yml>
const { createHash } = require("node:crypto")
const { readFileSync, writeFileSync, statSync } = require("node:fs")
const { basename } = require("node:path")
const yaml = require("js-yaml")

const [, , zipPath, ymlPath] = process.argv
if (!zipPath || !ymlPath) {
  console.error("Usage: node fix-update-manifest.js <path-to-rebuilt.zip> <path-to-latest-mac.yml>")
  process.exit(1)
}

const zipBuffer = readFileSync(zipPath)
const sha512 = createHash("sha512").update(zipBuffer).digest("base64")
const size = statSync(zipPath).size
const zipName = basename(zipPath)

const manifest = yaml.load(readFileSync(ymlPath, "utf-8"))

let patched = 0
for (const file of manifest.files ?? []) {
  if (file.url === zipName) {
    file.sha512 = sha512
    file.size = size
    patched++
  }
}
// Legacy top-level fields some electron-updater versions still read.
if (manifest.path === zipName) {
  manifest.sha512 = sha512
  patched++
}

if (patched === 0) {
  console.error(`No entry for ${zipName} found in ${ymlPath} — nothing patched.`)
  process.exit(1)
}

writeFileSync(ymlPath, yaml.dump(manifest))
console.log(`Patched ${ymlPath}: ${zipName} sha512/size updated to match the rebuilt zip.`)
