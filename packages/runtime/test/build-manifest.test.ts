import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';
import type { BuildPlugin } from '../../cli/src/lib/types.ts';

const discoveryOnlyPlugin: BuildPlugin = {
	name: 'discovery-only',
	bundle: 'none',
	entryFilename: 'server.mjs',
	generateEntryPoint(ctx) {
		return `export default ${JSON.stringify({
			agents: ctx.agents.map((agent) => agent.name),
			workflows: ctx.workflows.map((workflow) => workflow.name),
			channels: ctx.channels.map((channel) => channel.name),
		})};\n`;
	},
};

describe('build discovery outputs', () => {
	it('discovers modules without emitting a disk manifest', async () => {
		const root = createFixtureRoot('flue-discovery-output-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `export const arbitrary = true;\n`);
		fs.writeFileSync(path.join(root, 'workflows', 'job.ts'), `export default 'ordinary module';\n`);

		await expect(build({ root, plugin: discoveryOnlyPlugin })).resolves.toEqual({ changed: true });
		expect(fs.existsSync(path.join(root, 'dist', 'manifest.json'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'dist', 'server.bundled.js'))).toBe(false);
		expect(fs.readFileSync(path.join(root, 'dist', 'server.mjs'), 'utf-8')).toContain('assistant');
		expect(fs.readFileSync(path.join(root, 'dist', 'server.mjs'), 'utf-8')).toContain('job');
	});

	it('removes obsolete disk manifests from previous builds', async () => {
		const root = createFixtureRoot('flue-obsolete-manifest-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'dist'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, 'dist', 'manifest.json'), '{}');

		await build({ root, plugin: discoveryOnlyPlugin });
		expect(fs.existsSync(path.join(root, 'dist', 'manifest.json'))).toBe(false);
	});

	it('discovers channel modules beneath the selected source root only', async () => {
		const root = createFixtureRoot('flue-channel-discovery-');
		fs.mkdirSync(path.join(root, 'channels'));
		fs.mkdirSync(path.join(root, '.flue', 'agents'), { recursive: true });
		fs.mkdirSync(path.join(root, '.flue', 'channels'));
		fs.writeFileSync(path.join(root, 'channels', 'bare.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, '.flue', 'agents', 'assistant.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, '.flue', 'channels', 'github.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, '.flue', 'channels.ts'), `export default null;\n`);

		await build({ root, plugin: discoveryOnlyPlugin });
		const entry = fs.readFileSync(path.join(root, 'dist', 'server.mjs'), 'utf-8');
		expect(entry).toContain('github');
		expect(entry).not.toContain('bare');
	});

	it('rejects duplicate channel basenames', async () => {
		const root = createFixtureRoot('flue-duplicate-channels-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'channels'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, 'channels', 'github.ts'), `export default null;\n`);
		fs.writeFileSync(path.join(root, 'channels', 'github.js'), `export default null;\n`);

		await expect(build({ root, plugin: discoveryOnlyPlugin })).rejects.toThrow('Duplicate channel basename "github"');
	});
});

function createFixtureRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
