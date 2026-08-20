import { app, safeStorage } from "electron"
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { readFile, writeFile } from "fs/promises"

interface ConfigFile {
  groqApiKeyEncrypted?: string
  groqApiKey?: string
  [key: string]: unknown
}

function configPath(): string {
  return join(app.getPath("userData"), "config.json")
}

function readConfigSync(): ConfigFile {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConfigFile
  } catch {
    return {}
  }
}

async function readConfig(): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(configPath(), "utf-8")) as ConfigFile
  } catch {
    return {}
  }
}

async function writeConfig(config: ConfigFile): Promise<void> {
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8")
}

function decryptKey(config: ConfigFile): string | null {
  if (config.groqApiKeyEncrypted) {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(config.groqApiKeyEncrypted, "base64"))
    } catch {
      return null
    }
  }
  if (typeof config.groqApiKey === "string" && config.groqApiKey) {
    return config.groqApiKey
  }
  return null
}

/** Loads the saved Groq API key synchronously (used at startup before the IPC layer is up).
 * Migrates a legacy plaintext key to encrypted storage when possible. */
export function loadGroqApiKeySync(): string | null {
  const config = readConfigSync()
  const key = decryptKey(config)
  if (key && config.groqApiKey && safeStorage.isEncryptionAvailable()) {
    void saveGroqApiKey(key)
  }
  return key
}

export async function saveGroqApiKey(groqApiKey: string): Promise<void> {
  const config = await readConfig()
  delete config.groqApiKey
  if (safeStorage.isEncryptionAvailable()) {
    config.groqApiKeyEncrypted = safeStorage.encryptString(groqApiKey).toString("base64")
  } else {
    // No OS-level encryption backend available — fall back to plaintext rather than losing the key.
    config.groqApiKey = groqApiKey
  }
  await writeConfig(config)
}
