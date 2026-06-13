import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createTelegramChannel,
	InvalidTelegramConversationKeyError,
	InvalidTelegramInputError,
	type TelegramChannel,
	type TelegramConversationRef,
} from '../src/index.ts';

describe('createTelegramChannel()', () => {
	it('normalizes a verified command message with thread identity', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({
			secretToken: 'telegram_secret-42',
			webhook,
		});
		const raw = {
			update_id: 910_201,
			message: {
				message_id: 77,
				date: 1_781_100_001,
				message_thread_id: 314,
				from: {
					id: 883_001,
					is_bot: false,
					first_name: 'Mina',
					last_name: 'Vale',
					username: 'mina_vale',
					language_code: 'en',
				},
				chat: {
					id: -1_001_778_812_345,
					type: 'supergroup',
					title: 'Edge Operations',
				},
				text: '/triage@FieldBot inspect cache headers',
				entities: [{ offset: 0, length: 16, type: 'bot_command' }],
			},
		};

		const response = await channelApp(telegram).request(
			request(raw, 'telegram_secret-42'),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			update: {
				type: 'message',
				kind: 'message',
				updateId: 910_201,
				conversation: {
					type: 'chat',
					chatId: -1_001_778_812_345,
					messageThreadId: 314,
				},
				message: {
					messageId: 77,
					date: 1_781_100_001,
					from: {
						id: 883_001,
						firstName: 'Mina',
						lastName: 'Vale',
						username: 'mina_vale',
					},
					chat: {
						id: -1_001_778_812_345,
						type: 'supergroup',
						title: 'Edge Operations',
					},
					text: '/triage@FieldBot inspect cache headers',
					command: {
						name: 'triage',
						botUsername: 'FieldBot',
						arguments: 'inspect cache headers',
						raw: '/triage@FieldBot',
					},
					media: [],
				},
				raw,
			},
		});
	});

	it('keeps business chats distinct from regular chats', async () => {
		const updates: unknown[] = [];
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook({ update }) {
				updates.push(update);
			},
		});
		const app = channelApp(telegram);

		const regularResponse = await app.request(
			request(
				messageUpdate('message', {
					message_id: 81,
					date: 1_781_100_010,
					chat: { id: 445_101, type: 'private', first_name: 'Rhea' },
					text: 'regular message',
				}),
				'secret',
			),
		);
		const businessResponse = await app.request(
			request(
				messageUpdate('business_message', {
					message_id: 82,
					date: 1_781_100_011,
					business_connection_id: 'business-cobalt',
					chat: { id: 445_101, type: 'private', first_name: 'Rhea' },
					text: 'business message',
				}),
				'secret',
			),
		);

		expect(regularResponse.status).toBe(200);
		expect(businessResponse.status).toBe(200);
		expect(updates).toMatchObject([
			{
				type: 'message',
				kind: 'message',
				conversation: { type: 'chat', chatId: 445_101 },
			},
			{
				type: 'message',
				kind: 'business_message',
				conversation: {
					type: 'business-chat',
					businessConnectionId: 'business-cobalt',
					chatId: 445_101,
				},
			},
		]);
	});

	it('normalizes guest messages without creating durable conversation identity', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({ secretToken: 'secret', webhook });
		const raw = messageUpdate('guest_message', {
			message_id: 91,
			date: 1_781_100_020,
			guest_query_id: 'guest-query-amber',
			chat: { id: -1_001_001_202_303, type: 'supergroup', title: 'Public Forum' },
			text: 'Can the bot summarize this topic?',
		});

		const response = await channelApp(telegram).request(request(raw, 'secret'));

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].update).toMatchObject({
			type: 'message',
			kind: 'guest_message',
			capabilities: { guestQueryId: 'guest-query-amber' },
		});
		expect(webhook.mock.calls[0]?.[0].update.message).not.toHaveProperty(
			'guestQueryId',
		);
		expect(webhook.mock.calls[0]?.[0].update).not.toHaveProperty('conversation');
	});

	it('normalizes callback queries with and without chat identity', async () => {
		const seen: unknown[] = [];
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook({ update }) {
				seen.push(update);
			},
		});
		const app = channelApp(telegram);
		const messageCallback = {
			update_id: 910_204,
			callback_query: {
				id: 'callback-maple',
				from: { id: 700_101, is_bot: false, first_name: 'Noor' },
				chat_instance: 'chat-instance-17',
				data: 'approve:17',
				message: {
					message_id: 106,
					date: 1_781_100_030,
					chat: { id: 552_004, type: 'private', first_name: 'Noor' },
					text: 'Approve the deployment?',
				},
			},
		};
		const inlineCallback = {
			update_id: 910_205,
			callback_query: {
				id: 'callback-inline',
				from: { id: 700_102, is_bot: false, first_name: 'Ivo' },
				chat_instance: 'chat-instance-inline',
				game_short_name: 'orbit_runner',
				inline_message_id: 'inline-message-55',
			},
		};

		const messageResponse = await app.request(request(messageCallback, 'secret'));
		const inlineResponse = await app.request(request(inlineCallback, 'secret'));

		expect(messageResponse.status).toBe(200);
		expect(inlineResponse.status).toBe(200);
		expect(seen).toMatchObject([
			{
				type: 'callback_query',
				callback: { id: 'callback-maple', data: 'approve:17' },
				conversation: { type: 'chat', chatId: 552_004 },
			},
			{
				type: 'callback_query',
				callback: {
					id: 'callback-inline',
					gameShortName: 'orbit_runner',
					inlineMessageId: 'inline-message-55',
				},
			},
		]);
		expect(seen[1]).not.toHaveProperty('conversation');
	});

	it('normalizes individual and aggregate message reactions', async () => {
		const seen: unknown[] = [];
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook({ update }) {
				seen.push(update);
			},
		});
		const app = channelApp(telegram);

		const individual = {
			update_id: 910_206,
			message_reaction: {
				chat: { id: -100_778_991, type: 'channel', title: 'Release Notes' },
				message_id: 17,
				date: 1_781_100_040,
				user: { id: 900_002, is_bot: false, first_name: 'Ari' },
				old_reaction: [],
				new_reaction: [{ type: 'emoji', emoji: '👍' }],
			},
		};
		const aggregate = {
			update_id: 910_207,
			message_reaction_count: {
				chat: { id: -100_778_991, type: 'channel', title: 'Release Notes' },
				message_id: 17,
				date: 1_781_100_045,
				reactions: [{ type: { type: 'emoji', emoji: '👍' }, total_count: 8 }],
			},
		};

		expect((await app.request(request(individual, 'secret'))).status).toBe(200);
		expect((await app.request(request(aggregate, 'secret'))).status).toBe(200);
		expect(seen).toMatchObject([
			{
				type: 'message_reaction',
				messageId: 17,
				user: { id: 900_002 },
				conversation: { type: 'chat', chatId: -100_778_991 },
			},
			{
				type: 'message_reaction_count',
				messageId: 17,
				conversation: { type: 'chat', chatId: -100_778_991 },
			},
		]);
	});

	it('forwards one unsupported verified update variant explicitly', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({ secretToken: 'secret', webhook });
		const raw = {
			update_id: 910_208,
			shipping_query: {
				id: 'shipping-saffron',
				invoice_payload: 'order-204',
			},
		};

		const response = await channelApp(telegram).request(request(raw, 'secret'));

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].update).toEqual({
			type: 'unknown',
			updateId: 910_208,
			updateType: 'shipping_query',
			payload: raw.shipping_query,
			raw,
		});
	});

	it('rejects missing or changed secret tokens before application behavior', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({
			secretToken: 'expected_secret',
			webhook,
		});
		const raw = messageUpdate('message', {
			message_id: 1,
			date: 1_781_100_050,
			chat: { id: 42, type: 'private', first_name: 'Kai' },
			text: 'hello',
		});
		const app = channelApp(telegram);

		const missing = await app.request(request(raw));
		const changed = await app.request(request(raw, 'expected_secreu'));

		expect(missing.status).toBe(401);
		expect(changed.status).toBe(401);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects malformed Update envelopes, payloads, media, and oversized bodies', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({ secretToken: 'secret', webhook });
		const app = channelApp(telegram);
		const ambiguous = {
			update_id: 1,
			message: {
				message_id: 1,
				date: 1,
				chat: { id: 1, type: 'private', first_name: 'A' },
			},
			edited_message: {
				message_id: 1,
				date: 1,
				chat: { id: 1, type: 'private', first_name: 'A' },
			},
		};
		const invalidBusiness = messageUpdate('business_message', {
			message_id: 2,
			date: 2,
			chat: { id: 2, type: 'private', first_name: 'B' },
		});
		const invalidMedia = new Request('https://example.test/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
				'x-telegram-bot-api-secret-token': 'secret',
			},
			body: '{}',
		});

		expect((await app.request(request(ambiguous, 'secret'))).status).toBe(400);
		expect((await app.request(request(invalidBusiness, 'secret'))).status).toBe(400);
		expect((await app.request(invalidMedia)).status).toBe(415);
		const limited = createTelegramChannel({
			secretToken: 'secret',
			bodyLimit: 180,
			webhook,
		});
		expect(
			(
				await channelApp(limited).request(
					request(
						{
							update_id: 3,
							poll: { id: 'poll-large', explanation: 'x'.repeat(300) },
						},
						'secret',
					),
				)
			).status,
		).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('uses empty 200, JSON webhook replies, and Hono responses', async () => {
		const raw = messageUpdate('message', {
			message_id: 5,
			date: 5,
			chat: { id: 5, type: 'private', first_name: 'Moe' },
			text: 'response',
		});
		const empty = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		const json = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => ({
				method: 'sendChatAction',
				chat_id: 5,
				action: 'typing',
			}),
		});
		const hono = createTelegramChannel({
			secretToken: 'secret',
			webhook: ({ c }) => c.json({ retry: true }, 503),
		});

		const emptyResponse = await channelApp(empty).request(request(raw, 'secret'));
		const jsonResponse = await channelApp(json).request(request(raw, 'secret'));
		const honoResponse = await channelApp(hono).request(request(raw, 'secret'));

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(await jsonResponse.json()).toEqual({
			method: 'sendChatAction',
			chat_id: 5,
			action: 'typing',
		});
		expect(honoResponse.status).toBe(503);
	});

	it('returns 500 when application behavior throws or returns non-JSON data', async () => {
		const raw = messageUpdate('message', {
			message_id: 6,
			date: 6,
			chat: { id: 6, type: 'private', first_name: 'Sol' },
		});
		const throwing = createTelegramChannel({
			secretToken: 'secret',
			webhook() {
				throw new Error('failed');
			},
		});
		const invalid = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => new Map() as never,
		});

		expect((await channelApp(throwing).request(request(raw, 'secret'))).status).toBe(
			500,
		);
		expect((await channelApp(invalid).request(request(raw, 'secret'))).status).toBe(
			500,
		);
	});

	it('round-trips regular, business, thread, and direct-topic conversation keys', () => {
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		const refs: TelegramConversationRef[] = [
			{ type: 'chat' as const, chatId: -1_001_992, messageThreadId: 21 },
			{
				type: 'chat' as const,
				chatId: -1_001_993,
				directMessagesTopicId: 22,
			},
			{
				type: 'business-chat' as const,
				businessConnectionId: 'business:cyan',
				chatId: 998_201,
			},
		];

		for (const ref of refs) {
			const key = telegram.conversationKey(ref);
			expect(telegram.parseConversationKey(key)).toEqual(ref);
		}
		expect(telegram.conversationKey(refs[2] as TelegramConversationRef)).toBe(
			'telegram:v1:business:business%3Acyan:chat:998201:thread::direct:',
		);
	});

	it('rejects non-canonical keys, overlapping topic identity, and invalid setup', () => {
		expect(() =>
			createTelegramChannel({
				secretToken: 'contains space',
				webhook: () => undefined,
			}),
		).toThrow(InvalidTelegramInputError);
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		expect(() =>
			telegram.conversationKey({
				type: 'chat',
				chatId: 1,
				messageThreadId: 2,
				directMessagesTopicId: 3,
			}),
		).toThrow(InvalidTelegramInputError);
		expect(() =>
			telegram.parseConversationKey(
				'telegram:v1:regular:chat:01:thread::direct:',
			),
		).toThrow(InvalidTelegramConversationKeyError);
		expect(telegram.routes).toHaveLength(1);
		expect(telegram.routes[0]).toMatchObject({
			method: 'POST',
			path: '/webhook',
		});
	});
});

function channelApp(channel: TelegramChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function request(value: unknown, secret?: string): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...(secret === undefined
				? {}
				: { 'x-telegram-bot-api-secret-token': secret }),
		},
		body: JSON.stringify(value),
	});
}

function messageUpdate(
	field:
		| 'message'
		| 'edited_message'
		| 'channel_post'
		| 'edited_channel_post'
		| 'business_message'
		| 'edited_business_message'
		| 'guest_message',
	message: Record<string, unknown>,
): Record<string, unknown> {
	nextUpdateId += 1;
	return { update_id: nextUpdateId, [field]: message };
}

let nextUpdateId = 920_000;
