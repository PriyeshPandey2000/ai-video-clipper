#!/usr/bin/env node
// Run after `electron-builder --dir` (see package:dir in package.json). electron-builder copies
// node_modules by glob over apps/desktop/node_modules, not by checking what the built main/preload
// bundles actually require() — so it happily ships a build missing a runtime dependency with no
// error (electron-log/electron-updater both did this, see #119). require() only fails once the
// packaged app launches, which nothing in CI exercises. This closes that gap without needing a
// real display: find every bare require() specifier the built bundle references, then resolve
// each one from inside the packaged app dir exactly as Node would at runtime.

const { readdirSync, statSync, readFileSync, existsSync } = require("fs")
const { join, dirname, basename } = require("path")
const { builtinModules } = require("module")

const RELEASE_DIR = join(__dirname, "..", "release")

// electron-builder's unpacked output puts the app dir at <ProductName>.app/Contents/Resources/app
// on mac, <target>-unpacked/resources/app on win/linux — matching on "an 'app' dir directly under
// a 'resources' dir" (case-insensitive) covers both without hardcoding the mac bundle layout.
function findAppDir(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null // permission-restricted bundle internals (e.g. inside .framework) — not our target
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".framework")) continue
    const full = join(dir, entry.name)
    if (entry.name === "app" && /^resources$/i.test(basename(dirname(full)))) {
      return full
    }
    const found = findAppDir(full)
    if (found) return found
  }
  return null
}

function collectJsFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectJsFiles(full))
    else if (entry.name.endsWith(".js")) files.push(full)
  }
  return files
}

// Matches require("x") / require('x') with a literal string argument. Dynamic requires
// (template literals, variables) are always relative paths inside a package we already copy
// wholesale, so skipping them here doesn't reopen the gap this script exists to close.
const REQUIRE_RE = /require\(\s*(["'])((?:(?!\1).)+)\1\s*\)/g

function specifiersIn(file) {
  const src = readFileSync(file, "utf8")
  const specs = []
  for (const match of src.matchAll(REQUIRE_RE)) specs.push(match[2])
  return specs
}

function isBareSpecifier(specifier) {
  return (
    specifier !== "electron" &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("node:") &&
    !builtinModules.includes(specifier)
  )
}

function topLevelPackageName(specifier) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

// sharp (used by the local transcription pipeline) require()s a per-platform/arch native binding
// — e.g. @img/sharp-wasm32 — inside its own try/catch fallback chain, declared as an
// optionalDependency precisely because only the binding matching the current host is ever
// installed. Any such name is expected to be unresolvable on this machine and isn't a real gap —
// collect every optionalDependency declared by a package actually shipped in the app so this
// script doesn't flag sharp's own by-design platform branching as a missing dependency.
function collectOptionalDepNames(nodeModulesDir) {
  const names = new Set()
  let pkgDirs
  try {
    pkgDirs = readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of pkgDirs) {
    if (!entry.isDirectory()) continue
    const scanOne = (pkgDir) => {
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
        for (const name of Object.keys(pkg.optionalDependencies || {})) names.add(name)
      } catch {
        // not a package dir (e.g. a scope folder like @img) or no package.json — fine, skip
      }
    }
    if (entry.name.startsWith("@")) {
      const scopeDir = join(nodeModulesDir, entry.name)
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) scanOne(join(scopeDir, scoped.name))
      }
    } else {
      scanOne(join(nodeModulesDir, entry.name))
    }
  }
  return names
}

// Deliberately not require.resolve(spec, { paths: [appDir] }) — Node's resolver walks up every
// ancestor directory's node_modules, and in CI (or on any machine still inside this repo
// checkout) that walk reaches apps/desktop/node_modules and the workspace root, both full of the
// very packages we're trying to verify got copied into the *packaged* app. That upward walk
// would silently paper over a module missing from appDir/node_modules — the exact failure mode
// this script exists to catch (confirmed by testing: deleting electron-log from a packaged build
// and re-running with require.resolve still reported success, found via the ancestor walk).
// Resolving by hand, scoped strictly to appDir/node_modules, is the only way to see what an
// extracted end-user build — with no surrounding repo — would actually have.
function resolveWithinApp(appDir, specifier) {
  const pkgName = topLevelPackageName(specifier)
  const pkgDir = join(appDir, "node_modules", ...pkgName.split("/"))
  if (!existsSync(pkgDir)) return false
  if (specifier === pkgName) return true // bare package import — directory presence is enough

  const subpath = "." + specifier.slice(pkgName.length) // e.g. "electron-log/main" -> "./main"
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
  } catch {
    return false
  }

  const exported = pkg.exports && pkg.exports[subpath]
  if (exported) {
    const target = typeof exported === "string" ? exported : exported.default || exported.node
    return typeof target === "string" && existsSync(join(pkgDir, target))
  }
  if (pkg.exports) return false // exports map present but doesn't list this subpath — not importable

  // No exports map: old-style subpath import resolves like a relative require from the package root.
  return (
    existsSync(join(pkgDir, subpath)) ||
    existsSync(join(pkgDir, `${subpath}.js`)) ||
    existsSync(join(pkgDir, subpath, "index.js"))
  )
}

function main() {
  const appDir = findAppDir(RELEASE_DIR)
  if (!appDir) {
    console.error(`No packaged app found under ${RELEASE_DIR} — run package:dir first.`)
    process.exit(1)
  }

  const bundleDirs = ["main", "preload"]
    .map((name) => join(appDir, "out", name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })

  const bareSpecifiers = new Map() // specifier -> first file it was found in
  for (const dir of bundleDirs) {
    for (const file of collectJsFiles(dir)) {
      for (const spec of specifiersIn(file)) {
        if (isBareSpecifier(spec) && !bareSpecifiers.has(spec)) {
          bareSpecifiers.set(spec, file)
        }
      }
    }
  }

  const optionalDepNames = collectOptionalDepNames(join(appDir, "node_modules"))

  const failures = []
  for (const [spec, file] of bareSpecifiers) {
    if (optionalDepNames.has(topLevelPackageName(spec))) continue
    if (!resolveWithinApp(appDir, spec)) {
      failures.push({ spec, file })
    }
  }

  if (failures.length > 0) {
    console.error(
      `${failures.length} require()'d module(s) are missing from the packaged app's node_modules:\n`,
    )
    for (const { spec, file } of failures) {
      console.error(`  "${spec}" (referenced in ${file})`)
    }
    console.error(
      "\nAdd the missing package to apps/desktop/scripts/before-build.js's copyDepTree calls " +
        "(or to apps/desktop/package.json's build.files if it's hoisted into apps/desktop/node_modules already).",
    )
    process.exit(1)
  }

  console.log(`All ${bareSpecifiers.size} externalized runtime dependencies resolve. OK.`)
}

main()
