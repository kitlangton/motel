import { RGBA, TextAttributes } from "@opentui/core"
import { BlankRow, TextLine } from "./primitives.tsx"
import { colors } from "./theme.ts"
import { fitCell, truncateText } from "./format.ts"
import type { AttrFacetState, AttrPickerMode } from "./state.ts"

export interface AttrFilterModalProps {
	readonly width: number
	readonly height: number
	readonly mode: Exclude<AttrPickerMode, "off">
	readonly input: string
	readonly selectedIndex: number
	readonly selectedKey: string | null
	readonly state: AttrFacetState
	readonly onClose: () => void
}

// Filter + rank facet rows by the user's current input so typing is
// responsive even on large key sets. Values list skips this — attribute
// values are usually opaque ids that users paste in whole.
export const filterFacets = (
	rows: readonly { readonly value: string; readonly count: number }[],
	input: string,
): readonly { readonly value: string; readonly count: number }[] => {
	const needle = input.trim().toLowerCase()
	if (!needle) return rows
	return rows.filter((row) => row.value.toLowerCase().includes(needle))
}

export const AttrFilterModal = ({
	width,
	height,
	mode,
	input,
	selectedIndex,
	selectedKey,
	state,
	onClose,
}: AttrFilterModalProps) => {
	const panelWidth = Math.min(92, Math.max(60, width - 10))
	const left = Math.max(2, Math.floor((width - panelWidth) / 2))
	const top = Math.max(1, Math.floor(height / 6))
	const innerWidth = panelWidth - 4
	const rows = filterFacets(state.data, input)
	const clampedIndex =
		rows.length === 0
			? 0
			: Math.max(0, Math.min(selectedIndex, rows.length - 1))
	const visibleRowCount = Math.max(5, Math.min(18, height - top - 8))
	const windowStart = Math.max(
		0,
		clampedIndex - Math.floor(visibleRowCount / 2),
	)
	const windowEnd = Math.min(rows.length, windowStart + visibleRowCount)
	const windowed = rows.slice(windowStart, windowEnd)

	const title =
		mode === "keys"
			? "Filter traces by attribute key"
			: `Filter · ${truncateText(selectedKey ?? "", innerWidth - 14)}`

	const hint =
		mode === "keys"
			? "type to narrow · ↑↓ move · enter select · esc cancel"
			: "type to narrow · ↑↓ move · enter apply · backspace keys · esc cancel"

	const countWidth = 7
	const valueWidth = Math.max(10, innerWidth - countWidth - 1)

	const renderRow = (
		row: { readonly value: string; readonly count: number },
		isSelected: boolean,
	) => {
		const label = fitCell(row.value, valueWidth)
		const count = String(row.count).padStart(countWidth - 1) + " "
		if (isSelected) {
			return (
				<TextLine fg={colors.text} bg={colors.selectedBg}>
					<span fg={colors.accent} attributes={TextAttributes.BOLD}>
						{label}
					</span>
					<span fg={colors.muted}> </span>
					<span fg={colors.muted}>{count}</span>
				</TextLine>
			)
		}
		return (
			<TextLine>
				<span fg={colors.text}>{label}</span>
				<span fg={colors.muted}> </span>
				<span fg={colors.count}>{count}</span>
			</TextLine>
		)
	}

	return (
		<box
			position="absolute"
			zIndex={3000}
			left={0}
			top={0}
			width={width}
			height={height}
			backgroundColor={RGBA.fromInts(0, 0, 0, 110)}
			onMouseUp={onClose}
		>
			<box
				position="absolute"
				left={left}
				top={top}
				width={panelWidth}
				flexDirection="column"
				backgroundColor={RGBA.fromInts(20, 20, 28, 255)}
			>
				<box
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
					flexDirection="column"
				>
					<TextLine>
						<span fg={colors.count} attributes={TextAttributes.BOLD}>
							{truncateText(title, innerWidth)}
						</span>
					</TextLine>
					<TextLine>
						<span fg={colors.muted}>{truncateText(hint, innerWidth)}</span>
					</TextLine>
					<BlankRow />
					<TextLine fg={colors.accent}>
						<span fg={colors.muted}>{"\u203a "}</span>
						<span fg={colors.text}>
							{truncateText(input, Math.max(1, innerWidth - 4))}
						</span>
						<span fg={colors.accent}>{"\u2588"}</span>
					</TextLine>
					<BlankRow />
					{state.status === "loading" && rows.length === 0 ? (
						<TextLine>
							<span fg={colors.muted}>loading…</span>
						</TextLine>
					) : state.error ? (
						<TextLine>
							<span fg={colors.error}>
								{truncateText(state.error, innerWidth)}
							</span>
						</TextLine>
					) : rows.length === 0 ? (
						<TextLine>
							<span fg={colors.muted}>no matches</span>
						</TextLine>
					) : (
						windowed.map((row, i) => (
							<box key={row.value} height={1}>
								{renderRow(row, windowStart + i === clampedIndex)}
							</box>
						))
					)}
					{rows.length > windowEnd ? (
						<TextLine>
							<span
								fg={colors.muted}
							>{`+${rows.length - windowEnd} more…`}</span>
						</TextLine>
					) : null}
				</box>
			</box>
		</box>
	)
}
