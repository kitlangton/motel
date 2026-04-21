import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { config } from "../config.ts"
import { defaultThemeName, type ThemeName } from "./theme.ts"

const lastServicePath = `${dirname(config.otel.databasePath)}/last-service.txt`

export const readLastService = (): string | null => {
	try {
		return readFileSync(lastServicePath, "utf-8").trim() || null
	} catch {
		return null
	}
}

let lastPersistedService = readLastService()

export const persistSelectedService = (service: string) => {
	if (service === lastPersistedService) return
	lastPersistedService = service
	Bun.write(lastServicePath, service).catch(() => {})
}

const lastThemePath = `${dirname(config.otel.databasePath)}/last-theme.txt`

export const readLastTheme = (): ThemeName => {
	try {
		const raw = readFileSync(lastThemePath, "utf-8").trim()
		return raw === "tokyo-night" ||
			raw === "catppuccin" ||
			raw === "motel-default"
			? raw
			: defaultThemeName
	} catch {
		return defaultThemeName
	}
}

let lastPersistedTheme = readLastTheme()

export const persistSelectedTheme = (theme: ThemeName) => {
	if (theme === lastPersistedTheme) return
	lastPersistedTheme = theme
	Bun.write(lastThemePath, theme).catch(() => {})
}
