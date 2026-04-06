import { TextAttributes } from "@opentui/core"
import { colors } from "./theme.ts"
import { fitCell, truncateText } from "./format.ts"
import type { DetailView } from "./state.ts"

export const BlankRow = () => <box height={1} />

export const PlainLine = ({ text, fg = colors.text, bold = false }: { text: string; fg?: string; bold?: boolean }) => (
	<box height={1}>
		{bold ? (
			<text wrapMode="none" truncate fg={fg} attributes={TextAttributes.BOLD}>
				{text}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{text}
			</text>
		)}
	</box>
)

export const TextLine = ({ children, fg = colors.text, bg }: { children: React.ReactNode; fg?: string; bg?: string | undefined }) => (
	<box height={1}>
		{bg ? (
			<text wrapMode="none" truncate fg={fg} bg={bg}>
				{children}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{children}
			</text>
		)}
	</box>
)

export const AlignedHeaderLine = ({ left, right, width, rightFg = colors.muted }: { left: string; right: string; width: number; rightFg?: string }) => {
	const availableRightWidth = Math.max(8, width - left.length - 2)
	const rightText = truncateText(right, availableRightWidth)
	const gap = Math.max(2, width - left.length - rightText.length)

	return (
		<TextLine>
			<span fg={colors.accent} attributes={TextAttributes.BOLD}>{left}</span>
			<span fg={colors.muted}>{" ".repeat(gap)}</span>
			<span fg={rightFg}>{rightText}</span>
		</TextLine>
	)
}

export const Divider = ({ width, junctionAt, junctionChar }: { width: number; junctionAt?: number; junctionChar?: string }) => {
	if (junctionAt === undefined || junctionChar === undefined || junctionAt < 0 || junctionAt >= width) {
		return <PlainLine text={"\u2500".repeat(Math.max(1, width))} fg={colors.separator} />
	}

	return <PlainLine text={`${"\u2500".repeat(junctionAt)}${junctionChar}${"\u2500".repeat(Math.max(0, width - junctionAt - 1))}`} fg={colors.separator} />
}

export const SeparatorColumn = ({ height, junctionRow }: { height: number; junctionRow?: number }) => (
	<box width={1} height={height} flexDirection="column">
		{Array.from({ length: height }, (_, index) => (
			<PlainLine key={index} text={junctionRow === index ? "\u251c" : "\u2502"} fg={colors.separator} />
		))}
	</box>
)

export const FilterBar = ({ text, width }: { text: string; width: number }) => (
	<TextLine fg={colors.accent}>
		<span fg={colors.muted}>{"/"}</span>
		<span fg={colors.text}>{fitCell(text, width - 2)}</span>
		<span fg={colors.accent}>{"\u2588"}</span>
	</TextLine>
)

export const FooterHints = ({ spanNavActive, detailView, autoRefresh, width }: { spanNavActive: boolean; detailView: DetailView; autoRefresh: boolean; width: number }) => {
	const firstLine = "j/k move  ^n/^p traces  ^d/^u page"
	const secondLine = [
		detailView === "service-logs" ? "enter trace" : `enter ${spanNavActive && detailView === "waterfall" ? "detail" : "spans"}`,
		spanNavActive ? `esc ${detailView === "span-detail" ? "back" : "traces"}` : null,
		"/ filter",
		`a live:${autoRefresh ? "on" : "off"}`,
		"tab logs",
		"[/] svc",
		"r refresh",
		"o open",
		"q quit",
	]
		.filter((segment) => segment !== null)
		.join("  ")

	return (
		<box flexDirection="column">
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				{fitCell(firstLine, width)}
			</TextLine>
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				{fitCell(secondLine, width)}
			</TextLine>
		</box>
	)
}
