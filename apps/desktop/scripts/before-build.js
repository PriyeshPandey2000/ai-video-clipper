module.exports = async function ({ appDir, electronVersion, arch, platform }) {
  const { execFileSync } = await import("node:child_process")
  const { resolve, join, dirname } = await import("node:path")
  const fs = (await import("node:fs")).default

  // better-sqlite3 is a native addon — node-gyp always builds it for the HOST OS running this
  // script, never the packaging target. That's fine for package:mac run on a Mac, but
  // package:win/package:linux run from a Mac would silently bundle a macOS binary into a Windows
  // or Linux package (broken at runtime, no build-time error otherwise). electron-builder's
  // Platform.nodeName uses the same values as process.platform (darwin/linux/win32), so this
  // comparison is exact, not a guess. Fail loudly instead of shipping a broken artifact — true
  // cross-compilation would need a matching-OS runner or prebuilt target-specific binaries.
  if (platform.nodeName !== process.platform) {
    throw new Error(
      `Cannot build native dependencies for ${platform.name} while running on ${process.platform}. ` +
        `better-sqlite3 is a native addon and does not cross-compile — run this packaging target ` +
        `on a ${platform.name} runner (or matching CI job), or provide a prebuilt ` +
        `better-sqlite3 binary for ${platform.name}/${arch} before packaging.`,
    )
  }

  function copyReal(src, dst) {
    // On a second run (electron-builder can invoke beforeBuild more than once, or a developer
    // re-runs packaging locally), require.resolve below finds the copy this function already
    // placed at dst instead of the original hoisted source — src and dst end up identifying the
    // same directory. Without this guard, rmSync would delete dst right before cpSync tries to
    // read it as src. Comparing realpathSync(dst) (not dst itself) against src — which is already
    // canonical, from resolveRealDir's own realpathSync — catches this even when appDir is
    // reached through a symlink, where dst's lexical path wouldn't string-equal src even though
    // both resolve to the same place on disk.
    if (fs.existsSync(dst) && src === fs.realpathSync(dst)) return
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
  // reached via a workspace symlink. (copyReal no-ops if it's already the same path.)
  copyReal(sqlite3Real, sqlite3Dir)

  // 3. Same treatment for bindings + file-uri-to-path (better-sqlite3's own native-loader deps),
  // which are almost never hoisted to appDir/node_modules even when better-sqlite3 itself is.
  copyReal(resolveRealDir("bindings"), join(appDir, "node_modules", "bindings"))
  copyReal(resolveRealDir("file-uri-to-path"), join(appDir, "node_modules", "file-uri-to-path"))

  console.log("Native deps prepared.\n")
  // Return false so electron-builder skips its own rebuild (crashes on pnpm workspace symlinks)
  return false
}
