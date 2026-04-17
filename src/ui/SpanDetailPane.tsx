import type { LogItem, TraceItem, TraceSpanItem } from "../domain.ts"
import { formatDuration, lifecycleLabel } from "./format.ts"
import { AlignedHeaderLine, Divider, PlainLine, TextLine } from "./primitives.tsx"
import { SpanDetailView } from "./SpanDetail.tsx"
import { colors, SEPARATOR } from "./theme.ts"

/**
 * Level-2 view: focused span. Renders a header matching
 * `TraceDetailsPane` geometry (so wide-mode side-by-side layouts line up
 * vertically) plus a body that can grow to fill the available height.
 *
 * Total height: `bodyLines + HEADER_ROWS`.
 */
export const SPAN_DETAIL_HEADER_ROWS = 4

export const SpanDetailPane = ({
	span,
	trace,
	logs,
	contentWidth,
	bodyLines,
	paneWidth,
	focused = false,
}: {
	span: TraceSpanItem | null
	trace: TraceItem | null
	logs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
	paneWidth: number
	focused?: boolean
}) => {
	const focusIndicator = focused ? "\u25b8 " : ""
	const headerTitle = `${focusIndicator}SPAN`
	const headerRight = span
		? `${span.status} \u00b7 ${formatDuration(span.durationMs)}${logs.length > 0 ? ` \u00b7 ${logs.length} lg` : ""}`
		: "no span selected"
	const headerColor = span
		? span.isRunning
			? colors.warning
			: span.status === "error"
			? colors.error
			: colors.passing
		: colors.muted

	return (
		<box flexDirection="column" width={paneWidth} height={bodyLines + SPAN_DETAIL_HEADER_ROWS} overflow="hidden">
			<box paddingLeft={1} paddingRight={0}>
				<AlignedHeaderLine left={headerTitle} right={headerRight} width={contentWidth} rightFg={headerColor} />
			</box>
			{span && trace ? (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<TextLine>
							<span fg={colors.text}>{span.operationName}</span>
						</TextLine>
						<TextLine>
							<span fg={colors.defaultService}>{span.serviceName}</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{span.scopeName ?? "no scope"}</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={span.isRunning ? colors.warning : colors.muted}>{lifecycleLabel(span)}</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{span.spanId.slice(0, 16)}</span>
						</TextLine>
					</box>
					<Divider width={paneWidth} />
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<SpanDetailView
							span={span}
							logs={logs}
							contentWidth={contentWidth}
							bodyLines={bodyLines}
						/>
					</box>
				</>
			) : (
				<>
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<TextLine><span fg={colors.muted}>—</span></TextLine>
						<TextLine><span fg={colors.muted}>—</span></TextLine>
					</box>
					<Divider width={paneWidth} />
					<box flexDirection="column" paddingLeft={1} paddingRight={0}>
						<PlainLine text="Select a span in the waterfall to view its detail." fg={colors.muted} />
					</box>
				</>
			)}
		</box>
	)
}
