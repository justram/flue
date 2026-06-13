import type { Env, Handler } from 'hono';
import type {
	JsonValue,
	TelegramCallbackQueryPayload,
	TelegramChannelOptions,
	TelegramChatRef,
	TelegramCommand,
	TelegramConversationRef,
	TelegramHandlerResult,
	TelegramGuestCapabilities,
	TelegramMediaKind,
	TelegramMessageKind,
	TelegramMessagePayload,
	TelegramUpdate,
	TelegramUserRef,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const MESSAGE_UPDATE_FIELDS = new Map<string, TelegramMessageKind>([
	['message', 'message'],
	['edited_message', 'edited_message'],
	['channel_post', 'channel_post'],
	['edited_channel_post', 'edited_channel_post'],
	['business_message', 'business_message'],
	['edited_business_message', 'edited_business_message'],
	['guest_message', 'guest_message'],
]);

const MEDIA_FIELDS: readonly [TelegramMediaKind, string][] = [
	['animation', 'animation'],
	['audio', 'audio'],
	['document', 'document'],
	['live_photo', 'live_photo'],
	['paid_media', 'paid_media'],
	['photo', 'photo'],
	['sticker', 'sticker'],
	['story', 'story'],
	['video', 'video'],
	['video_note', 'video_note'],
	['voice', 'voice'],
];

export function createTelegramWebhookHandler<E extends Env>(
	options: TelegramChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Telegram webhook bodyLimit must be a positive integer.');
	}
	const expectedSecretDigest = digestSecret(options.secretToken);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		if (
			!secureEqual(
				await expectedSecretDigest,
				await digestSecret(
					request.headers.get('x-telegram-bot-api-secret-token') ?? '',
				),
			)
		) {
			return response(401);
		}

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		const raw = parseJson(body.value);
		if (!isRecord(raw)) return response(400);
		const update = normalizeUpdate(raw);
		if (!update) return response(400);

		let result: TelegramHandlerResult;
		try {
			result = await options.webhook({ c, update });
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result);
	};
}

function normalizeUpdate(raw: Record<string, unknown>): TelegramUpdate | undefined {
	const updateId = readSafeInteger(raw, 'update_id');
	if (updateId === undefined || updateId < 0) return undefined;
	const fields = Object.keys(raw).filter((key) => key !== 'update_id');
	if (fields.length !== 1) return undefined;
	const updateType = fields[0] as string;
	const payload = raw[updateType];

	const messageKind = MESSAGE_UPDATE_FIELDS.get(updateType);
	if (messageKind) {
		if (!isRecord(payload)) return undefined;
		const normalizedMessage = normalizeMessage(payload);
		if (!normalizedMessage) return undefined;
		const { message, guestQueryId } = normalizedMessage;
		const conversation = conversationFromMessage(messageKind, message);
		if (messageKind === 'business_message' || messageKind === 'edited_business_message') {
			if (!conversation || conversation.type !== 'business-chat') return undefined;
		}
		if (messageKind === 'guest_message' && !guestQueryId) return undefined;
		if (messageKind !== 'guest_message' && guestQueryId) return undefined;
		const capabilities: TelegramGuestCapabilities | undefined = guestQueryId
			? { guestQueryId }
			: undefined;
		return {
			type: 'message',
			kind: messageKind,
			updateId,
			message,
			...(conversation === undefined ? {} : { conversation }),
			...(capabilities === undefined ? {} : { capabilities }),
			raw,
		};
	}

	if (updateType === 'callback_query') {
		if (!isRecord(payload)) return undefined;
		const callback = normalizeCallbackQuery(payload);
		if (!callback) return undefined;
		const conversation = callback.message
			? conversationFromMessage('message', callback.message)
			: undefined;
		return {
			type: 'callback_query',
			updateId,
			callback,
			...(conversation === undefined ? {} : { conversation }),
			raw,
		};
	}

	if (updateType === 'message_reaction') {
		if (!isRecord(payload)) return undefined;
		const chat = normalizeChat(readRecord(payload, 'chat'));
		const messageId = readSafeInteger(payload, 'message_id');
		const date = readSafeInteger(payload, 'date');
		const oldReaction = payload.old_reaction;
		const newReaction = payload.new_reaction;
		const userRaw = readRecord(payload, 'user');
		const actorChatRaw = readRecord(payload, 'actor_chat');
		const user = normalizeUser(userRaw);
		const actorChat = normalizeChat(actorChatRaw);
		if (
			!chat ||
			messageId === undefined ||
			messageId < 0 ||
			date === undefined ||
			date < 0 ||
			!Array.isArray(oldReaction) ||
			!Array.isArray(newReaction) ||
			(userRaw !== undefined && !user) ||
			(actorChatRaw !== undefined && !actorChat) ||
			(user ? 1 : 0) + (actorChat ? 1 : 0) !== 1
		) {
			return undefined;
		}
		return {
			type: 'message_reaction',
			updateId,
			chat,
			messageId,
			date,
			...(user === undefined ? {} : { user }),
			...(actorChat === undefined ? {} : { actorChat }),
			oldReaction,
			newReaction,
			conversation: { type: 'chat', chatId: chat.id },
			raw,
		};
	}

	if (updateType === 'message_reaction_count') {
		if (!isRecord(payload)) return undefined;
		const chat = normalizeChat(readRecord(payload, 'chat'));
		const messageId = readSafeInteger(payload, 'message_id');
		const date = readSafeInteger(payload, 'date');
		if (
			!chat ||
			messageId === undefined ||
			messageId < 0 ||
			date === undefined ||
			date < 0 ||
			!Array.isArray(payload.reactions)
		) {
			return undefined;
		}
		return {
			type: 'message_reaction_count',
			updateId,
			chat,
			messageId,
			date,
			reactions: payload.reactions,
			conversation: { type: 'chat', chatId: chat.id },
			raw,
		};
	}

	return {
		type: 'unknown',
		updateId,
		updateType,
		payload,
		raw,
	};
}

function normalizeMessage(
	raw: Record<string, unknown>,
): { message: TelegramMessagePayload; guestQueryId?: string } | undefined {
	const messageId = readSafeInteger(raw, 'message_id');
	const date = readSafeInteger(raw, 'date');
	const chat = normalizeChat(readRecord(raw, 'chat'));
	if (
		messageId === undefined ||
		messageId < 0 ||
		date === undefined ||
		date < 0 ||
		!chat
	) {
		return undefined;
	}
	const fromRaw = readRecord(raw, 'from');
	const senderChatRaw = readRecord(raw, 'sender_chat');
	const from = normalizeUser(fromRaw);
	const senderChat = normalizeChat(senderChatRaw);
	if ((fromRaw && !from) || (senderChatRaw && !senderChat)) return undefined;

	const text = readOptionalString(raw, 'text');
	const caption = readOptionalString(raw, 'caption');
	const command = normalizeCommand(raw, text, caption);
	if (command === null) return undefined;
	const messageThreadId = readOptionalPositiveInteger(raw, 'message_thread_id');
	if (raw.message_thread_id !== undefined && messageThreadId === undefined) {
		return undefined;
	}
	const directTopicRaw = readRecord(raw, 'direct_messages_topic');
	const directMessagesTopicId = directTopicRaw
		? readPositiveInteger(directTopicRaw, 'topic_id')
		: undefined;
	if (directTopicRaw && directMessagesTopicId === undefined) return undefined;
	if (messageThreadId !== undefined && directMessagesTopicId !== undefined) {
		return undefined;
	}
	const businessConnectionId = readOptionalString(raw, 'business_connection_id');
	const guestQueryId = readOptionalString(raw, 'guest_query_id');

	return {
		message: {
			messageId,
			date,
			chat,
			...(from === undefined ? {} : { from }),
			...(senderChat === undefined ? {} : { senderChat }),
			...(text === undefined ? {} : { text }),
			...(caption === undefined ? {} : { caption }),
			...(command === undefined ? {} : { command }),
			...(messageThreadId === undefined ? {} : { messageThreadId }),
			...(directMessagesTopicId === undefined
				? {}
				: { directMessagesTopicId }),
			...(businessConnectionId === undefined
				? {}
				: { businessConnectionId }),
			media: MEDIA_FIELDS.filter(([, field]) => Object.hasOwn(raw, field)).map(
				([kind]) => kind,
			),
		},
		...(guestQueryId === undefined ? {} : { guestQueryId }),
	};
}

function normalizeCallbackQuery(
	raw: Record<string, unknown>,
): TelegramCallbackQueryPayload | undefined {
	const id = readNonEmptyString(raw, 'id');
	const from = normalizeUser(readRecord(raw, 'from'));
	const chatInstance = readNonEmptyString(raw, 'chat_instance');
	if (!id || !from || !chatInstance) return undefined;
	const messageRaw = readRecord(raw, 'message');
	const normalizedMessage = messageRaw ? normalizeMessage(messageRaw) : undefined;
	if (messageRaw && !normalizedMessage) return undefined;
	const message = normalizedMessage?.message;
	if (normalizedMessage?.guestQueryId) return undefined;
	const inlineMessageId = readOptionalString(raw, 'inline_message_id');
	const data = readOptionalString(raw, 'data');
	const gameShortName = readOptionalString(raw, 'game_short_name');
	if ((message ? 1 : 0) + (inlineMessageId ? 1 : 0) !== 1) return undefined;
	if ((data ? 1 : 0) + (gameShortName ? 1 : 0) !== 1) return undefined;
	return {
		id,
		from,
		chatInstance,
		...(data === undefined ? {} : { data }),
		...(gameShortName === undefined ? {} : { gameShortName }),
		...(inlineMessageId === undefined ? {} : { inlineMessageId }),
		...(message === undefined ? {} : { message }),
	};
}

function conversationFromMessage(
	kind: TelegramMessageKind,
	message: TelegramMessagePayload,
): TelegramConversationRef | undefined {
	if (kind === 'guest_message') return undefined;
	const topic = {
		...(message.messageThreadId === undefined
			? {}
			: { messageThreadId: message.messageThreadId }),
		...(message.directMessagesTopicId === undefined
			? {}
			: { directMessagesTopicId: message.directMessagesTopicId }),
	};
	if (message.businessConnectionId) {
		return {
			type: 'business-chat',
			businessConnectionId: message.businessConnectionId,
			chatId: message.chat.id,
			...topic,
		};
	}
	return { type: 'chat', chatId: message.chat.id, ...topic };
}

function normalizeCommand(
	raw: Record<string, unknown>,
	text: string | undefined,
	caption: string | undefined,
): TelegramCommand | undefined | null {
	const source = text ?? caption;
	if (source === undefined) return undefined;
	const entityField = text === undefined ? 'caption_entities' : 'entities';
	const entities = raw[entityField];
	if (entities === undefined) return undefined;
	if (!Array.isArray(entities)) return null;
	const commandEntity = entities.find(
		(entity) =>
			isRecord(entity) &&
			entity.type === 'bot_command' &&
			entity.offset === 0,
	);
	if (!commandEntity || !isRecord(commandEntity)) return undefined;
	const length = readPositiveInteger(commandEntity, 'length');
	if (length === undefined || length > source.length) return null;
	const rawCommand = source.slice(0, length);
	const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(rawCommand);
	if (!match?.[1]) return null;
	return {
		name: match[1],
		...(match[2] === undefined ? {} : { botUsername: match[2] }),
		arguments: source.slice(length).trimStart(),
		raw: rawCommand,
	};
}

function normalizeUser(raw: Record<string, unknown> | undefined): TelegramUserRef | undefined {
	if (!raw) return undefined;
	const id = readSafeInteger(raw, 'id');
	const isBot = raw.is_bot;
	const firstName = readNonEmptyString(raw, 'first_name');
	if (id === undefined || id <= 0 || typeof isBot !== 'boolean' || !firstName) {
		return undefined;
	}
	return {
		id,
		isBot,
		firstName,
		...optionalStringFields(raw, ['last_name', 'username', 'language_code'], {
			last_name: 'lastName',
			username: 'username',
			language_code: 'languageCode',
		}),
	};
}

function normalizeChat(raw: Record<string, unknown> | undefined): TelegramChatRef | undefined {
	if (!raw) return undefined;
	const id = readSafeInteger(raw, 'id');
	const type = raw.type;
	if (
		id === undefined ||
		id === 0 ||
		(type !== 'private' &&
			type !== 'group' &&
			type !== 'supergroup' &&
			type !== 'channel')
	) {
		return undefined;
	}
	return {
		id,
		type,
		...optionalStringFields(
			raw,
			['title', 'username', 'first_name', 'last_name'],
			{
				title: 'title',
				username: 'username',
				first_name: 'firstName',
				last_name: 'lastName',
			},
		),
	};
}

function optionalStringFields<
	TSource extends string,
	TTarget extends string,
>(
	raw: Record<string, unknown>,
	keys: readonly TSource[],
	targets: Record<TSource, TTarget>,
): Partial<Record<TTarget, string>> {
	const result: Partial<Record<TTarget, string>> = {};
	for (const key of keys) {
		const value = readOptionalString(raw, key);
		if (value !== undefined) result[targets[key]] = value;
	}
	return result;
}

function serializeHandlerResult(value: unknown): Response {
	if (value instanceof Response) return value;
	if (value === undefined) return response(200);
	if (!isJsonValue(value)) return response(500);
	return Response.json(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
	seen.add(value);
	try {
		return Array.isArray(value)
			? value.every((item) => isJsonValue(item, seen))
			: Object.values(value).every((item) => isJsonValue(item, seen));
	} finally {
		seen.delete(value);
	}
}

function secureEqual(expected: Uint8Array, actual: Uint8Array): boolean {
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected[index] as number) ^ (actual[index] as number);
	}
	return difference === 0;
}

async function digestSecret(secret: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
}

function isJsonRequest(request: Request): boolean {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null && !/^\d+$/.test(contentLength)) return false;
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<
	| { type: 'success'; value: Uint8Array }
	| { type: 'too-large' }
	| { type: 'invalid' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > bodyLimit) {
		return { type: 'too-large' };
	}
	if (!request.body) return { type: 'success', value: new Uint8Array() };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				void reader.cancel();
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { type: 'invalid' };
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { type: 'success', value: body };
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(body));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	return isRecord(value[key]) ? value[key] : undefined;
}

function readNonEmptyString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function readOptionalString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function readSafeInteger(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isSafeInteger(field)
		? field
		: undefined;
}

function readPositiveInteger(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const field = readSafeInteger(value, key);
	return field !== undefined && field > 0 ? field : undefined;
}

function readOptionalPositiveInteger(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	return value[key] === undefined ? undefined : readPositiveInteger(value, key);
}

function response(status: number): Response {
	return new Response(null, { status });
}
