import type { FlueClient, FlueEvent } from '@flue/sdk';
import {
	type ConsoleTranscript,
	createConsoleTranscript,
	reduceConsoleTranscript,
	type TranscriptAction,
} from './console-transcript.ts';
import type { ExecutionLifecycle, PreparedExecution, StartedExecution } from './execution-lifecycle.ts';
import { parseAgentInput, runTarget } from './run-controller.ts';

type ConsoleStatus =
	| 'preparing'
	| 'building'
	| 'starting'
	| 'ready'
	| 'active'
	| 'completed'
	| 'failed'
	| 'closing'
	| 'closed'
	| 'detached';

export interface ConsoleSnapshot {
	readonly resource?: { kind: 'agent' | 'workflow'; name: string };
	readonly id?: string;
	readonly target?: 'node' | 'cloudflare';
	readonly server?: string;
	readonly remote: boolean;
	readonly status: ConsoleStatus;
	readonly active: boolean;
	readonly composerEnabled: boolean;
	readonly transcript: ConsoleTranscript;
}

export interface ConsoleControllerOptions {
	readonly lifecycle: ExecutionLifecycle;
	readonly initialInput?: unknown;
}

export interface ConsoleController {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => ConsoleSnapshot;
	start(): Promise<void>;
	submit(message: string): Promise<void>;
	recordServerOutput(line: string, stream: 'stdout' | 'stderr'): void;
	setLifecycleStatus(status: 'preparing' | 'building' | 'starting' | 'ready'): void;
	close(): Promise<void>;
	forceCloseSync(): void;
}

export function createConsoleController(options: ConsoleControllerOptions): ConsoleController {
	const listeners = new Set<() => void>();
	let snapshot: ConsoleSnapshot = {
		remote: false,
		status: 'preparing',
		active: false,
		composerEnabled: false,
		transcript: createConsoleTranscript(),
	};
	let started: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	const activeControllers = new Set<AbortController>();
	let execution: StartedExecution | undefined;
	let prepared: PreparedExecution | undefined;
	let closing = false;

	const publish = (next: Partial<ConsoleSnapshot>, action?: TranscriptAction) => {
		snapshot = {
			...snapshot,
			...next,
			transcript: action ? reduceConsoleTranscript(snapshot.transcript, action) : snapshot.transcript,
		};
		for (const listener of listeners) listener();
	};

	const controller: ConsoleController = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
		start() {
			if (started) return started;
			started = start();
			return started;
		},
		async submit(message) {
			if (closing) throw new Error('Console is closing.');
			if (!execution || execution.resource.kind !== 'agent') throw new Error('Agent console is not ready.');
			const input = parseAgentInput({ message });
			publish({}, { type: 'prompt', message: input.message });
			await execute(execution.client, {
				kind: 'agent',
				name: execution.resource.name,
				instanceId: execution.instanceId as string,
				input,
			});
		},
		recordServerOutput(line, stream) {
			if (!closing) publish({}, { type: 'server', line, stream });
		},
		setLifecycleStatus(status) {
			if (!snapshot.active && !closing) publish({ status }, { type: 'status', message: lifecycleStatusMessage(status) });
		},
		close() {
			if (closePromise) return closePromise;
			closing = true;
			const startup = started;
			closePromise = (async () => {
				publish({ status: 'closing', composerEnabled: false });
				for (const controller of activeControllers) controller.abort();
				options.lifecycle.cancel();
				try {
					await startup;
					await options.lifecycle.close();
					publish({ status: snapshot.remote ? 'detached' : 'closed', active: false });
				} catch (error) {
					publish({ status: 'failed', active: false }, { type: 'error', error });
					throw error;
				}
			})();
			return closePromise;
		},
		forceCloseSync() {
			closing = true;
			for (const controller of activeControllers) controller.abort();
			options.lifecycle.forceCloseSync();
		},
	};
	return controller;

	async function start(): Promise<void> {
		try {
			prepared = await options.lifecycle.prepare();
			if (closing) return;
			publish({
				resource: prepared.resource,
				id: prepared.instanceId,
				target: prepared.target,
				remote: prepared.remote,
				composerEnabled: false,
			});
			execution = await options.lifecycle.start();
			if (closing) return;
			publish({ server: execution.baseUrl, status: 'ready', composerEnabled: execution.resource.kind === 'agent' });
			if (execution.resource.kind === 'agent' && options.initialInput !== undefined) {
				const input = parseAgentInput(options.initialInput);
				publish({}, { type: 'prompt', message: input.message });
				await execute(execution.client, {
					kind: 'agent',
					name: execution.resource.name,
					instanceId: execution.instanceId as string,
					input,
				});
			} else if (execution.resource.kind === 'workflow') {
				await execute(execution.client, {
					kind: 'workflow',
					name: execution.resource.name,
					input: options.initialInput,
				});
			}
		} catch (error) {
			if (!closing && !options.lifecycle.signal.aborted) {
				publish({ status: 'failed', active: false, composerEnabled: false }, { type: 'error', error });
				closing = true;
				options.lifecycle.cancel();
				await options.lifecycle.close().catch(() => {});
				publish({ status: snapshot.remote ? 'detached' : 'closed' });
			}
		}
	}

	async function execute(client: FlueClient, target: Parameters<typeof runTarget>[1]): Promise<void> {
		if (closing) return;
		const activeController = new AbortController();
		activeControllers.add(activeController);
		const abort = () => activeController.abort(options.lifecycle.signal.reason);
		options.lifecycle.signal.addEventListener('abort', abort, { once: true });
		publish({ status: 'active', active: true, composerEnabled: target.kind === 'agent' });
		let failed = false;
		try {
			const result = await runTarget(client, target, onEvent, activeController.signal);
			if (closing) return;
			const id = result.kind === 'workflow' ? result.runId : snapshot.id;
			publish({ id }, { type: 'result', result: result.result });
		} catch (error) {
			failed = !activeController.signal.aborted;
			if (!closing && failed) publish({}, { type: 'error', error });
		} finally {
			options.lifecycle.signal.removeEventListener('abort', abort);
			activeControllers.delete(activeController);
			if (!closing) {
				const active = activeControllers.size > 0;
				publish({
					status: active ? 'active' : failed ? 'failed' : 'completed',
					active,
					composerEnabled: target.kind === 'agent',
				});
			}
		}
	}

	function onEvent(event: FlueEvent): void {
		if (closing) return;
		const id = event.type === 'run_start' ? event.runId : snapshot.id;
		publish({ id }, { type: 'event', event });
	}
}

function lifecycleStatusMessage(status: 'preparing' | 'building' | 'starting' | 'ready'): string {
	if (status === 'preparing') return 'preparing project';
	if (status === 'building') return 'building application';
	if (status === 'starting') return 'starting runtime';
	return 'runtime ready';
}
