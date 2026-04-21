// Storybook-style preview for AiChatView. Renders the component
// against a menu of fixtures so we can iterate on the rendering
// without needing real LLM traffic captured.
//
// Run it: `bun run story:chat`
// Keys:
//   1..N      switch fixture
//   j / k     scroll down / up (1 line)
//   ctrl-d/u  half-page
//   gg / G    jump to top / bottom
//   r         force re-render with a fresh date (to sanity-check headers)
//   q / ^c    quit

import { RegistryProvider } from "@effect/atom-react"
import { RGBA, TextAttributes, createCliRenderer } from "@opentui/core"
import {
	createRoot,
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { buildChunks, type Chunk } from "../ui/aiChatModel.ts"
import { AiChatView } from "../ui/AiChatView.tsx"
import { Divider, TextLine } from "../ui/primitives.tsx"
import type { AiCallDetailState } from "../ui/state.ts"
import { applyTheme, colors, SEPARATOR } from "../ui/theme.ts"
import type { ChatFixture } from "./fixtures/index.ts"
import { errorFixture } from "./fixtures/errorState.ts"
import { imagePasteFixture } from "./fixtures/imagePaste.ts"
import { kitchenSinkFixture } from "./fixtures/kitchenSink.ts"
import { rawPromptFixture } from "./fixtures/rawPrompt.ts"
import { shortFixture } from "./fixtures/short.ts"
import { toolHeavyFixture } from "./fixtures/toolHeavy.ts"

// Kitchen-sink first so launching the story lands on something that
// shows every rendering branch at once. The other fixtures exercise
// one case at a time for regression testing.
const FIXTURES: readonly ChatFixture[] = [
	kitchenSinkFixture,
	shortFixture,
	toolHeavyFixture,
	imagePasteFixture,
	rawPromptFixture,
	errorFixture,
]

const HEADER_ROWS = 2
const FOOTER_ROWS = 1

const StoryApp = () => {
	applyTheme("motel-default")
	const renderer = useRenderer()
	const { width, height } = useTerminalDimensions()
	const w = width ?? 120
	const h = height ?? 32
	const [fixtureIdx, setFixtureIdx] = useState(0)
	const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
	const [detailChunkId, setDetailChunkId] = useState<string | null>(null)
	const [detailScrollOffset, setDetailScrollOffset] = useState(0)
	const pendingGRef = useRef(false)
	const quittingRef = useRef(false)

	const fixture = FIXTURES[fixtureIdx] ?? FIXTURES[0]!

	const detailState: AiCallDetailState = useMemo(
		() => ({
			status: "ready",
			spanId: fixture.span.spanId,
			data: fixture.detail,
			error: null,
		}),
		[fixture],
	)

	const chunks = useMemo<readonly Chunk[]>(
		() => buildChunks(fixture.detail),
		[fixture],
	)

	// Reset selection + expansion whenever fixture changes.
	useEffect(() => {
		setSelectedChunkId(chunks[0]?.id ?? null)
		setDetailChunkId(null)
		setDetailScrollOffset(0)
	}, [fixtureIdx, chunks])

	const move = (delta: number) => {
		if (chunks.length === 0) return
		const idx = selectedChunkId
			? chunks.findIndex((c) => c.id === selectedChunkId)
			: 0
		const next = chunks[Math.max(0, Math.min(idx + delta, chunks.length - 1))]
		if (next) setSelectedChunkId(next.id)
	}

	useKeyboard((key) => {
		if (key.name === "q" || (key.ctrl && key.name === "c")) {
			// renderer.destroy() runs the opentui teardown (disables
			// mouse tracking / kitty keyboard / bracketed paste / alt
			// screen) before onDestroy exits the process. Bypassing it
			// with a raw process.exit leaks those escape sequences into
			// the host shell.
			if (quittingRef.current) return
			quittingRef.current = true
			renderer.destroy()
			return
		}
		if (/^[1-9]$/.test(key.name) && !key.ctrl && !key.meta) {
			const idx = parseInt(key.name, 10) - 1
			if (idx < FIXTURES.length) setFixtureIdx(idx)
			return
		}
		if (key.name === "j" || key.name === "down") {
			if (detailChunkId) setDetailScrollOffset((current) => current + 1)
			else move(1)
			return
		}
		if (key.name === "k" || key.name === "up") {
			if (detailChunkId)
				setDetailScrollOffset((current) => Math.max(0, current - 1))
			else move(-1)
			return
		}
		if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
			if (detailChunkId)
				setDetailScrollOffset(
					(current) => current + Math.max(1, Math.floor(bodyLines / 2)),
				)
			else move(Math.max(1, Math.floor(chunks.length / 4)))
			return
		}
		if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
			if (detailChunkId)
				setDetailScrollOffset((current) =>
					Math.max(0, current - Math.max(1, Math.floor(bodyLines / 2))),
				)
			else move(-Math.max(1, Math.floor(chunks.length / 4)))
			return
		}
		if (key.name === "g" && !key.shift) {
			if (detailChunkId) {
				if (pendingGRef.current) {
					setDetailScrollOffset(0)
					pendingGRef.current = false
				} else {
					pendingGRef.current = true
					setTimeout(() => {
						pendingGRef.current = false
					}, 500)
				}
				return
			}
			if (pendingGRef.current) {
				if (chunks[0]) setSelectedChunkId(chunks[0].id)
				pendingGRef.current = false
			} else {
				pendingGRef.current = true
				setTimeout(() => {
					pendingGRef.current = false
				}, 500)
			}
			return
		}
		if (key.name === "g" && key.shift) {
			if (detailChunkId) setDetailScrollOffset(999999)
			else {
				const last = chunks[chunks.length - 1]
				if (last) setSelectedChunkId(last.id)
			}
			return
		}
		if (key.name === "escape") {
			setDetailChunkId(null)
			setDetailScrollOffset(0)
			return
		}
		if (key.name === "return" || key.name === "enter") {
			const chunk = chunks.find((c) => c.id === selectedChunkId)
			if (chunk) {
				setDetailChunkId(chunk.id)
				setDetailScrollOffset(0)
			}
			return
		}
	})

	const bodyLines = Math.max(
		4,
		h - HEADER_ROWS - FOOTER_ROWS - 4 /* AI_CHAT_HEADER_ROWS */,
	)

	// Short compact labels — a single TextLine truncates with "..." if
	// it overflows the padded content width, so we keep labels tight and
	// use a single separator between items.
	const fixtureList = FIXTURES.map((f, i) => (
		<span key={f.id}>
			<span
				fg={i === fixtureIdx ? colors.accent : colors.muted}
				attributes={i === fixtureIdx ? TextAttributes.BOLD : undefined}
			>
				{`${i + 1} ${f.label}`}
			</span>
			{i < FIXTURES.length - 1 ? (
				<span fg={colors.separator}>{" \u00b7 "}</span>
			) : null}
		</span>
	))

	// Header + divider live inside a paddingLeft/Right={1} box, so the
	// real content width is `w - 2`. Divider must match or we get a
	// mid-line "..." truncation.
	const contentWidth = Math.max(8, w - 2)

	return (
		<box
			width={w}
			height={h}
			flexDirection="column"
			backgroundColor={RGBA.fromHex(colors.screenBg)}
		>
			<box
				paddingLeft={1}
				paddingRight={1}
				height={HEADER_ROWS}
				flexDirection="column"
			>
				<TextLine>
					<span fg={colors.muted} attributes={TextAttributes.BOLD}>
						AI CHAT
					</span>
					<span fg={colors.separator}>{" \u00b7 "}</span>
					{fixtureList}
				</TextLine>
				<Divider width={contentWidth} />
			</box>
			<AiChatView
				span={fixture.span}
				detailState={detailState}
				chunks={chunks}
				selectedChunkId={selectedChunkId}
				onSelectChunk={(chunkId) => setSelectedChunkId(chunkId)}
				detailChunkId={detailChunkId}
				onOpenDetail={(chunkId) => {
					setSelectedChunkId(chunkId)
					setDetailChunkId(chunkId)
					setDetailScrollOffset(0)
				}}
				onCloseDetail={() => {
					setDetailChunkId(null)
					setDetailScrollOffset(0)
				}}
				detailScrollOffset={detailScrollOffset}
				onSetDetailScrollOffset={(updater) => setDetailScrollOffset(updater)}
				contentWidth={Math.max(24, w - 2)}
				bodyLines={bodyLines}
				paneWidth={w}
			/>
			<Divider width={contentWidth} />
			<box paddingLeft={1} paddingRight={1} height={FOOTER_ROWS}>
				<TextLine>
					<span fg={colors.count} attributes={TextAttributes.BOLD}>
						1-9
					</span>
					<span fg={colors.muted}>{" fixture  "}</span>
					<span fg={colors.count} attributes={TextAttributes.BOLD}>
						j/k
					</span>
					<span fg={colors.muted}>{" move  "}</span>
					<span fg={colors.count} attributes={TextAttributes.BOLD}>
						enter
					</span>
					<span fg={colors.muted}>{" detail  "}</span>
					<span fg={colors.count} attributes={TextAttributes.BOLD}>
						gg/G
					</span>
					<span fg={colors.muted}>{" top/bottom  "}</span>
					<span fg={colors.count} attributes={TextAttributes.BOLD}>
						q
					</span>
					<span fg={colors.muted}>{" quit"}</span>
				</TextLine>
			</box>
		</box>
	)
}

const renderer = await createCliRenderer({
	exitOnCtrlC: false,
	screenMode: "alternate-screen",
	onDestroy: () => {
		process.exit(0)
	},
})

createRoot(renderer).render(
	<RegistryProvider>
		<StoryApp />
	</RegistryProvider>,
)
