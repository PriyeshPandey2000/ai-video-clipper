const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

module.exports = async function ({ appDir, electronVersion, arch }) {
  const sqlite3Dir = path.join(appDir, "node_modules", "better-sqlite3")
  if (!fs.existsSync(sqlite3Dir)) return false

  const nodeGypBin = path.resolve(appDir, "../../node_modules/.bin/node-gyp")

  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`)
  execSync(
    `"${nodeGypBin}" rebuild --target=${electronVersion} --arch=${arch} --dist-url=https://electronjs.org/headers`,
    { cwd: sqlite3Dir, stdio: "inherit" },
  )

  // Return false so electron-builder skips its own rebuild (crashes on pnpm workspace symlinks)
  return false
}
