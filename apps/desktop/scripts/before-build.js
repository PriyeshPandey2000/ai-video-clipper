module.exports = async function ({ appDir, electronVersion, arch }) {
  const { execFileSync } = await import("node:child_process")
  const { resolve, join, dirname } = await import("node:path")
  const fs = (await import("node:fs")).default

  function copyReal(src, dst) {
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(src, dst, { recursive: true, dereference: true })
  }

  // require.resolve walks up from appDir the same way Node's own module resolution does, so this
  // finds each package correctly whether it's hoisted to the repo root node_modules (this repo's
  // node-linker=hoisted setting), symlinked locally into appDir/node_modules, or nested in the
  // pnpm store — no assumptions about which layout is in effect. realpathSync follows through any
  // symlink to the actual on-disk package electron-builder needs to copy.
  function resolveRealDir(pkgName) {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`, { paths: [appDir] })
    return dirname(fs.realpathSync(pkgJsonPath))
  }

  const sqlite3Real = resolveRealDir("better-sqlite3")
  const sqlite3Dir = join(appDir, "node_modules", "better-sqlite3")

  const nodeGypBin = resolve(
    appDir,
    "../../node_modules/.bin",
    process.platform === "win32" ? "node-gyp.cmd" : "node-gyp",
  )

  // 1. Rebuild better-sqlite3 against Electron headers
  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`)
  execFileSync(
    nodeGypBin,
    [
      "rebuild",
      `--target=${electronVersion}`,
      `--arch=${arch}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: sqlite3Real, stdio: "inherit" },
  )

  // 2. Ensure a real (non-symlink) copy sits at appDir/node_modules so electron-builder's file
  // copy step picks it up — needed whether better-sqlite3 was hoisted to the repo root or
  // reached via a workspace symlink.
  if (sqlite3Real !== sqlite3Dir) {
    copyReal(sqlite3Real, sqlite3Dir)
  }

  // 3. Same treatment for bindings + file-uri-to-path (better-sqlite3's own native-loader deps),
  // which are almost never hoisted to appDir/node_modules even when better-sqlite3 itself is.
  copyReal(resolveRealDir("bindings"), join(appDir, "node_modules", "bindings"))
  copyReal(resolveRealDir("file-uri-to-path"), join(appDir, "node_modules", "file-uri-to-path"))

  console.log("Native deps prepared.\n")
  // Return false so electron-builder skips its own rebuild (crashes on pnpm workspace symlinks)
  return false
}
