const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

function copyReal(src, dst) {
  execSync(`rm -rf "${dst}" && cp -rL "${src}" "${dst}"`)
}

module.exports = async function ({ appDir, electronVersion, arch }) {
  const sqlite3Symlink = path.join(appDir, "node_modules", "better-sqlite3")
  if (!fs.existsSync(sqlite3Symlink)) {
    throw new Error(`better-sqlite3 not found at ${sqlite3Symlink} — run pnpm install first`)
  }

  const nodeGypBin = path.resolve(appDir, "../../node_modules/.bin/node-gyp")
  const sqlite3Real = fs.realpathSync(sqlite3Symlink)
  const isSymlink = sqlite3Real !== sqlite3Symlink

  // 1. Rebuild better-sqlite3 against Electron headers
  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`)
  execSync(
    `"${nodeGypBin}" rebuild --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`,
    { cwd: sqlite3Real, stdio: "inherit" },
  )

  // 2. Replace symlink with a real copy so electron-builder can include it
  // (only needed when it's still a symlink — subsequent runs it's already a real dir)
  if (isSymlink) {
    copyReal(sqlite3Real, sqlite3Symlink)
  }

  // 3. Copy bindings + file-uri-to-path from pnpm store (not hoisted to desktop node_modules)
  const pnpmStore = path.resolve(appDir, "../../node_modules/.pnpm")
  const entries = fs.readdirSync(pnpmStore)

  const bindingsPkg = entries.find((e) => e.startsWith("bindings@"))
  const fileUriPkg = entries.find((e) => e.startsWith("file-uri-to-path@"))

  if (bindingsPkg) {
    copyReal(
      path.join(pnpmStore, bindingsPkg, "node_modules", "bindings"),
      path.join(appDir, "node_modules", "bindings"),
    )
  }

  if (fileUriPkg) {
    copyReal(
      path.join(pnpmStore, fileUriPkg, "node_modules", "file-uri-to-path"),
      path.join(appDir, "node_modules", "file-uri-to-path"),
    )
  }

  console.log("Native deps prepared.\n")
  // Return false so electron-builder skips its own rebuild (crashes on pnpm workspace symlinks)
  return false
}
