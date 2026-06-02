import { describe, expect, it } from 'vitest';
import { Harness } from '../src/harness.ts';
import type { AgentConfig, SessionData, SessionEnv, SessionStore } from '../src/types.ts';

const SESSION_KEY = 'agent-session:["instance","default","case:1"]';

describe('session deletion lifecycle', () => {
	it('rejects deletion while a shell operation is active', async () => {
		let releaseExec!: () => void;
		let markExecStarted!: () => void;
		const execStarted = new Promise<void>((resolve) => {
			markExecStarted = resolve;
		});
		const execReleased = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});
		const store = new TrackingSessionStore();
		const harness = createHarness(store, {
			exec: async () => {
				markExecStarted();
				await execReleased;
				return { stdout: '', stderr: '', exitCode: 0 };
			},
		});
		const session = await harness.session('case:1');
		const shell = session.shell('hold');
		await execStarted;

		await expect(session.delete()).rejects.toThrow(
			'Session "case:1" cannot be deleted while shell is running',
		);
		expect(store.deleteCalls).toEqual([]);

		releaseExec();
		await shell;
		await session.delete();
		expect(store.deleteCalls).toEqual([SESSION_KEY]);
	});

	it('shares one deletion promise and marks the session unusable before storage deletion completes', async () => {
		const store = new TrackingSessionStore();
		const harness = createHarness(store);
		const session = await harness.session('case:1');
		store.blockDeletes();

		const first = session.delete();
		const second = session.delete();
		expect(second).toBe(first);
		await store.deleteStarted;
		await expect(session.shell('after delete')).rejects.toThrow(
			'Session "case:1" has been deleted',
		);
		expect(store.deleteCalls).toEqual([SESSION_KEY]);

		store.releaseDelete();
		await Promise.all([first, second]);
	});

	it('deduplicates concurrent opens for one session name', async () => {
		const store = new TrackingSessionStore();
		store.blockLoads();
		const harness = createHarness(store);

		const first = harness.session('case:1');
		const second = harness.session('case:1');
		await store.loadStarted;
		store.releaseLoad();

		expect(await second).toBe(await first);
		expect(store.loadCalls).toEqual([SESSION_KEY]);
	});

	it('waits for an in-flight open before deleting the named session', async () => {
		const store = new TrackingSessionStore();
		store.blockLoads();
		const harness = createHarness(store);

		const session = harness.session('case:1');
		await store.loadStarted;
		const deletion = harness.sessions.delete('case:1');
		expect(store.deleteCalls).toEqual([]);
		store.releaseLoad();

		await session;
		await deletion;
		expect(store.deleteCalls).toEqual([SESSION_KEY]);
		expect(await store.load(SESSION_KEY)).toBeNull();
	});

	it('does not replay a deduplicated open after an intervening named deletion', async () => {
		const store = new TrackingSessionStore();
		store.blockLoads();
		const harness = createHarness(store);

		const first = harness.session('case:1');
		const second = harness.session('case:1');
		await store.loadStarted;
		const deletion = harness.sessions.delete('case:1');
		store.releaseLoad();

		expect(await second).toBe(await first);
		await deletion;
		expect(await store.load(SESSION_KEY)).toBeNull();
	});

	it('rejects persisted session data written by an earlier beta', async () => {
		const store = new TrackingSessionStore();
		await store.save(SESSION_KEY, { ...emptySessionData(), version: 4 } as unknown as SessionData);
		const harness = createHarness(store);

		await expect(harness.session('case:1')).rejects.toThrow(
			'Session data version 4 is unsupported. Clear persisted session state created by an earlier Flue beta.',
		);
	});

	it('preserves get-or-create semantics after a queued get misses', async () => {
		const store = new TrackingSessionStore();
		store.blockLoads();
		const harness = createHarness(store);

		const missing = harness.sessions.get('case:1');
		const created = harness.session('case:1');
		await store.loadStarted;
		store.releaseLoad();

		await expect(missing).rejects.toThrow('does not exist');
		expect((await created).name).toBe('case:1');
		expect(await store.load(SESSION_KEY)).not.toBeNull();
	});

	it('preserves get semantics after a queued create finds stored state', async () => {
		const store = new TrackingSessionStore();
		await store.save(SESSION_KEY, emptySessionData());
		store.blockLoads();
		const harness = createHarness(store);

		const duplicate = harness.sessions.create('case:1');
		const loaded = harness.sessions.get('case:1');
		await store.loadStarted;
		store.releaseLoad();

		await expect(duplicate).rejects.toThrow('already exists');
		expect((await loaded).name).toBe('case:1');
	});

	it('queues a later named deletion after an intervening reopen', async () => {
		const store = new TrackingSessionStore();
		const harness = createHarness(store);
		await harness.session('case:1');
		store.blockDeletes();

		const firstDelete = harness.sessions.delete('case:1');
		await store.deleteStarted;
		const reopened = harness.session('case:1');
		const secondDelete = harness.sessions.delete('case:1');
		store.releaseDelete();

		await firstDelete;
		await reopened;
		await secondDelete;
		expect(store.deleteCalls).toEqual([SESSION_KEY, SESSION_KEY]);
		expect(await store.load(SESSION_KEY)).toBeNull();
	});
});

function createHarness(store: SessionStore, overrides: Partial<SessionEnv> = {}): Harness {
	return new Harness('instance', 'default', testAgentConfig(), createEnv(overrides), store);
}

function testAgentConfig(): AgentConfig {
	return { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined };
}

function emptySessionData(): SessionData {
	return {
		version: 5,
		affinityKey: 'aff_01J00000000000000000000000',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-05-31T00:00:00.000Z',
		updatedAt: '2026-05-31T00:00:00.000Z',
	};
}

function createEnv(overrides: Partial<SessionEnv> = {}): SessionEnv {
	return {
		cwd: '/repo',
		resolvePath: (path) => (path.startsWith('/') ? path : `/repo/${path}`),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 0,
			mtime: new Date(0),
		}),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		...overrides,
	};
}

class TrackingSessionStore implements SessionStore {
	private data = new Map<string, SessionData>();
	private resolveLoadStarted!: () => void;
	private resolveLoad!: () => void;
	private resolveDeleteStarted!: () => void;
	private resolveDelete!: () => void;
	private loadReleased = Promise.resolve();
	private deleteReleased = Promise.resolve();
	readonly loadCalls: string[] = [];
	readonly deleteCalls: string[] = [];
	loadStarted = Promise.resolve();
	deleteStarted = Promise.resolve();

	blockLoads(): void {
		this.loadStarted = new Promise<void>((resolve) => {
			this.resolveLoadStarted = resolve;
		});
		this.loadReleased = new Promise<void>((resolve) => {
			this.resolveLoad = resolve;
		});
	}

	releaseLoad(): void {
		this.resolveLoad();
	}

	blockDeletes(): void {
		this.deleteStarted = new Promise<void>((resolve) => {
			this.resolveDeleteStarted = resolve;
		});
		this.deleteReleased = new Promise<void>((resolve) => {
			this.resolveDelete = resolve;
		});
	}

	releaseDelete(): void {
		this.resolveDelete();
	}

	async save(id: string, data: SessionData): Promise<void> {
		this.data.set(id, data);
	}

	async load(id: string): Promise<SessionData | null> {
		this.loadCalls.push(id);
		this.resolveLoadStarted?.();
		await this.loadReleased;
		return this.data.get(id) ?? null;
	}

	async delete(id: string): Promise<void> {
		this.deleteCalls.push(id);
		this.resolveDeleteStarted?.();
		await this.deleteReleased;
		this.data.delete(id);
	}
}
