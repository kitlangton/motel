export interface ThemeColors {
	readonly screenBg: string
	readonly text: string
	readonly muted: string
	readonly separator: string
	readonly accent: string
	readonly error: string
	readonly selectedBg: string
	readonly warning: string
	readonly selectedText: string
	readonly count: string
	readonly passing: string
	readonly defaultService: string
	readonly footerBg: string
	readonly treeLine: string
	readonly previewKey: string
}

export interface ThemeWaterfallColors {
	readonly bar: string
	readonly barError: string
	readonly barBg: string
	readonly barLane: string
	readonly barSelected: string
	readonly barSelectedError: string
}

export interface ThemeDefinition {
	readonly name: ThemeName
	readonly label: string
	readonly colors: ThemeColors
	readonly waterfall: ThemeWaterfallColors
}

// motel-default palette derived in OKLCH. All "surface" tokens share hue
// 282 (twilight purple) at varying lightness so depth is communicated by
// lightness alone (footer < screen < selected < bar track). The amber
// accent (hue 73) sits almost complementary to the surfaces, giving the
// motel-sign neon maximum contrast without color clash.
const motelDefaultTheme: ThemeDefinition = {
	name: "motel-default",
	label: "Motel Default",
	colors: {
		screenBg: "#111120", // oklch(0.185 0.030 282)
		text: "#eee5d6", // oklch(0.925 0.022 82)  — warm cream
		muted: "#9a9181", // oklch(0.660 0.025 82)
		separator: "#686155", // oklch(0.495 0.020 81)
		accent: "#f5a41a", // oklch(0.780 0.161 73)  — motel neon
		error: "#f97312", // oklch(0.705 0.187 48)
		selectedBg: "#2b2c48", // oklch(0.305 0.050 282) — same hue as screen
		warning: "#facc16", // oklch(0.861 0.173 92)
		selectedText: "#f8fafc",
		count: "#d7c5a1", // oklch(0.830 0.052 85)
		passing: "#7ed5a4", // oklch(0.805 0.110 158)
		defaultService: "#93c5fe", // oklch(0.810 0.096 252)
		footerBg: "#04040e", // oklch(0.115 0.025 282) — deeper than screen
		treeLine: "#48433b", // oklch(0.385 0.015 80)
		previewKey: "#645d51", // oklch(0.480 0.020 80)
	},
	waterfall: {
		bar: "#f5a41a", // = accent
		barError: "#f97312", // = error
		barBg: "#1f1f34", // oklch(0.250 0.040 282) — purple track (was warm)
		barLane: "#3d3e5b", // oklch(0.375 0.050 282)
		barSelected: "#f3c048", // oklch(0.832 0.145 85) — warmer amber
		barSelectedError: "#ff8c42",
	},
}

const tokyoNightTheme: ThemeDefinition = {
	name: "tokyo-night",
	label: "Tokyo Night",
	colors: {
		screenBg: "#1a1b26",
		text: "#c0caf5",
		muted: "#7a88b6",
		separator: "#565f89",
		accent: "#7aa2f7",
		error: "#f7768e",
		selectedBg: "#283457",
		warning: "#e0af68",
		selectedText: "#f8fbff",
		count: "#bb9af7",
		passing: "#9ece6a",
		defaultService: "#73daca",
		footerBg: "#000000",
		treeLine: "#414868",
		previewKey: "#6b739c",
	},
	waterfall: {
		bar: "#7aa2f7",
		barError: "#f7768e",
		barBg: "#1f2335",
		barLane: "#2a3050",
		barSelected: "#bb9af7",
		barSelectedError: "#ff9eaf",
	},
}

const catppuccinTheme: ThemeDefinition = {
	name: "catppuccin",
	label: "Catppuccin Mocha",
	colors: {
		screenBg: "#11111b",
		text: "#cdd6f4",
		muted: "#a6adc8",
		separator: "#6c7086",
		accent: "#f5c2e7",
		error: "#f38ba8",
		selectedBg: "#313244",
		warning: "#f9e2af",
		selectedText: "#f5f7ff",
		count: "#fab387",
		passing: "#a6e3a1",
		defaultService: "#89dceb",
		footerBg: "#000000",
		treeLine: "#585b70",
		previewKey: "#9399b2",
	},
	waterfall: {
		bar: "#f5c2e7",
		barError: "#f38ba8",
		barBg: "#1e1e2e",
		barLane: "#313244",
		barSelected: "#fab387",
		barSelectedError: "#eba0ac",
	},
}

export const themes = {
	"motel-default": motelDefaultTheme,
	"tokyo-night": tokyoNightTheme,
	catppuccin: catppuccinTheme,
} as const

export type ThemeName = keyof typeof themes

export const defaultThemeName: ThemeName = "tokyo-night"

export const themeOrder: readonly ThemeName[] = [
	"tokyo-night",
	"catppuccin",
	"motel-default",
]

export const colors: ThemeColors = { ...themes[defaultThemeName].colors }
export const waterfallColors: ThemeWaterfallColors = {
	...themes[defaultThemeName].waterfall,
}

export const applyTheme = (name: ThemeName) => {
	const theme = themes[name] ?? themes[defaultThemeName]
	Object.assign(colors, theme.colors)
	Object.assign(waterfallColors, theme.waterfall)
	return theme
}

export const cycleThemeName = (current: ThemeName) => {
	const nextIndex = (themeOrder.indexOf(current) + 1) % themeOrder.length
	return themeOrder[nextIndex] ?? themeOrder[0]
}

export const themeLabel = (name: ThemeName) =>
	themes[name]?.label ?? themes[defaultThemeName].label

export const SEPARATOR = " \u00b7 "
export const G_PREFIX_TIMEOUT_MS = 500
