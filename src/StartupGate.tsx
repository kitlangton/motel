import { Effect } from "effect"
import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useState } from "react"
import { App } from "./App.js"
import {
	createDaemonManager,
	ensureManagedDaemon,
	getManagedDaemonStatus,
	type DaemonStatus,
} from "./daemon.js"
import { MOTEL_SERVICE_ID } from "./registry.js"
import { Divider, PlainLine, TextLine } from "./ui/primitives.tsx"
import { colors } from "./ui/theme.ts"

type ConflictStatus = DaemonStatus & {
	readonly service: typeof MOTEL_SERVICE_ID
	readonly pid: number
	readonly workdir: string
	readonly reason: string
	readonly sameWorkdir: false
}

type ConflictScreenState = {
	kind: "conflict"
	message: string
	status: ConflictStatus
	busy: boolean
	notice: string | null
}

type ErrorScreenState = {
	kind: "error"
	message: string
	busy: boolean
	notice: string | null
}

type StartupState =
	| { kind: "loading"; message: string }
	| { kind: "ready" }
	| ConflictScreenState
	| ErrorScreenState

type RecoveryAction = {
	readonly key: string
	readonly label: string
	readonly run: () => Promise<void>
	readonly disabled?: boolean
}

const readStatus = () => Effect.runPromise(getManagedDaemonStatus)
const startDaemon = () => Effect.runPromise(ensureManagedDaemon)

const parsePort = (url: string) => {
	try {
		const port = Number(new URL(url).port)
		return Number.isFinite(port) && port > 0 ? port : undefined
	} catch {
		return undefined
	}
}

const isRecoverableConflict = (
	status: DaemonStatus | null,
): status is ConflictStatus =>
	status !== null &&
	status.service === MOTEL_SERVICE_ID &&
	status.pid !== null &&
	status.workdir !== null &&
	status.reason !== null &&
	!status.sameWorkdir

const stopConflictingDaemon = async (status: ConflictStatus) => {
	const port = parsePort(status.url)
	const manager = createDaemonManager({
		workdir: status.workdir ?? undefined,
		databasePath: status.databasePath,
		port,
	})
	await Effect.runPromise(manager.stop)
}

const LoadingScreen = ({
	width,
	height,
	message,
}: {
	width: number
	height: number
	message: string
}) => {
	const panelWidth = Math.min(76, Math.max(50, width - 8))
	const left = Math.max(0, Math.floor((width - panelWidth) / 2))
	const top = Math.max(0, Math.floor((height - 5) / 2))

	return (
		<box
			width={width}
			height={height}
			backgroundColor={RGBA.fromHex(colors.screenBg)}
		>
			<box
				position="absolute"
				left={left}
				top={top}
				width={panelWidth}
				flexDirection="column"
			>
				<TextLine>
					<span fg={colors.accent} attributes={TextAttributes.BOLD}>
						MOTEL
					</span>
					<span fg={colors.separator}>{" · "}</span>
					<span fg={colors.muted}>starting up...</span>
				</TextLine>
				<Divider width={panelWidth} />
				<box paddingTop={1}>
					<PlainLine text={message} fg={colors.count} />
				</box>
			</box>
		</box>
	)
}

const RecoveryScreen = ({
	title,
	message,
	width,
	height,
	detailLines,
	actions,
	selectedIndex,
	notice,
	busy,
}: {
	readonly title: string
	readonly message: string
	readonly width: number
	readonly height: number
	readonly detailLines: readonly string[]
	readonly actions: readonly RecoveryAction[]
	readonly selectedIndex: number
	readonly notice: string | null
	readonly busy: boolean
}) => {
	const panelWidth = Math.min(96, Math.max(64, width - 8))
	const left = Math.max(0, Math.floor((width - panelWidth) / 2))
	const bodyHeight = 9 + detailLines.length + actions.length + (notice ? 2 : 0)
	const top = Math.max(0, Math.floor((height - bodyHeight) / 2))

	return (
		<box
			width={width}
			height={height}
			backgroundColor={RGBA.fromHex(colors.screenBg)}
		>
			<box
				position="absolute"
				left={left}
				top={top}
				width={panelWidth}
				flexDirection="column"
			>
				<TextLine>
					<span fg={colors.accent} attributes={TextAttributes.BOLD}>
						MOTEL
					</span>
					<span fg={colors.separator}>{" · "}</span>
					<span fg={colors.error} attributes={TextAttributes.BOLD}>
						{title}
					</span>
				</TextLine>
				<Divider width={panelWidth} />
				<box paddingTop={1} paddingBottom={1} flexDirection="column">
					<PlainLine text={message} fg={colors.text} />
				</box>
				{detailLines.map((line, index) => (
					<PlainLine key={`${index}:${line}`} text={line} fg={colors.muted} />
				))}
				<box paddingTop={1} flexDirection="column">
					{actions.map((action, index) => {
						const selected = index === selectedIndex
						const prefix = selected ? ">" : " "
						const text = `${prefix} [${action.key}] ${action.label}${action.disabled ? " (unavailable)" : ""}`
						return (
							<TextLine
								key={action.key}
								bg={selected ? colors.selectedBg : undefined}
							>
								<span fg={selected ? colors.selectedText : colors.text}>
									{text}
								</span>
							</TextLine>
						)
					})}
				</box>
				<box paddingTop={1} flexDirection="column">
					{notice ? (
						<PlainLine
							text={notice}
							fg={busy ? colors.warning : colors.count}
						/>
					) : null}
					<PlainLine
						text={
							busy
								? "Working..."
								: "j/k or ↑↓ select · enter run · r retry · k kill conflicting daemon · q quit"
						}
						fg={colors.count}
					/>
				</box>
			</box>
		</box>
	)
}

export const StartupGate = () => {
	const renderer = useRenderer()
	const { width = 100, height = 24 } = useTerminalDimensions()
	const [startupState, setStartupState] = useState<StartupState>({
		kind: "loading",
		message: "Checking managed daemon...",
	})
	const [selectedIndex, setSelectedIndex] = useState(0)

	const attemptStart = async () => {
		setStartupState({ kind: "loading", message: "Checking managed daemon..." })
		try {
			await startDaemon()
			setStartupState({ kind: "ready" })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const status = await readStatus().catch(() => null)
			if (isRecoverableConflict(status)) {
				setSelectedIndex(0)
				setStartupState({
					kind: "conflict",
					message,
					status,
					busy: false,
					notice: null,
				})
				return
			}
			setSelectedIndex(0)
			setStartupState({ kind: "error", message, busy: false, notice: null })
		}
	}

	useEffect(() => {
		void attemptStart()
	}, [])

	const actions = useMemo<readonly RecoveryAction[]>(() => {
		if (startupState.kind === "conflict") {
			return [
				{ key: "r", label: "Retry startup", run: attemptStart },
				{
					key: "k",
					label: `Stop conflicting daemon (${startupState.status.pid})`,
					run: async () => {
						setStartupState((current) =>
							current.kind === "conflict"
								? {
										...current,
										busy: true,
										notice: `Stopping daemon ${current.status.pid}...`,
									}
								: current,
						)
						try {
							await stopConflictingDaemon(startupState.status)
							await attemptStart()
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error)
							setStartupState((current) =>
								current.kind === "conflict"
									? { ...current, busy: false, notice: message }
									: current,
							)
						}
					},
				},
				{
					key: "q",
					label: "Quit",
					run: async () => {
						renderer.destroy()
					},
				},
			]
		}
		if (startupState.kind === "error") {
			return [
				{ key: "r", label: "Retry startup", run: attemptStart },
				{
					key: "q",
					label: "Quit",
					run: async () => {
						renderer.destroy()
					},
				},
			]
		}
		return []
	}, [renderer, startupState])

	useKeyboard((key) => {
		if (
			startupState.kind === "ready" ||
			startupState.kind === "loading" ||
			key.repeated
		)
			return
		if (key.name === "q" || (key.ctrl && key.name === "c")) {
			renderer.destroy()
			return
		}
		if (key.name === "up" || key.name === "k") {
			setSelectedIndex(
				(current) => (current + actions.length - 1) % actions.length,
			)
			return
		}
		if (key.name === "down" || key.name === "j") {
			setSelectedIndex((current) => (current + 1) % actions.length)
			return
		}
		if (key.name === "r") {
			void actions.find((action) => action.key === "r")?.run()
			return
		}
		if (key.name === "k") {
			void actions.find((action) => action.key === "k")?.run()
			return
		}
		if (key.name === "return" || key.name === "enter") {
			void actions[selectedIndex]?.run()
		}
	})

	if (startupState.kind === "ready") return <App />
	if (startupState.kind === "loading")
		return (
			<LoadingScreen
				width={width}
				height={height}
				message={startupState.message}
			/>
		)
	if (startupState.kind === "conflict") {
		const status = startupState.status
		const detailLines = [
			`Port: ${status.url}`,
			`Conflicting workdir: ${status.workdir}`,
			`Conflicting pid: ${status.pid}`,
			`Database: ${status.databasePath}`,
			status.workdir.startsWith("/tmp") ||
			status.workdir.startsWith("/private/tmp")
				? "This looks like a temp/test daemon."
				: "This looks like a real motel daemon started from another project.",
		]
		return (
			<RecoveryScreen
				title="Daemon Conflict"
				message={startupState.message}
				width={width}
				height={height}
				detailLines={detailLines}
				actions={actions}
				selectedIndex={selectedIndex}
				notice={startupState.notice}
				busy={startupState.busy}
			/>
		)
	}

	return (
		<RecoveryScreen
			title="Startup Error"
			message={startupState.message}
			width={width}
			height={height}
			detailLines={["Retry startup or quit the TUI."]}
			actions={actions}
			selectedIndex={selectedIndex}
			notice={startupState.notice}
			busy={startupState.busy}
		/>
	)
}
