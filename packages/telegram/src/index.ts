import type { Context, Env, Handler } from 'hono';
import {
	InvalidTelegramConversationKeyError,
	InvalidTelegramInputError,
} from './errors.ts';
import { createTelegramWebhookHandler } from './webhook.ts';

export {
	InvalidTelegramConversationKeyError,
	InvalidTelegramInputError,
} from './errors.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Ingress configuration for one Telegram bot webhook secret. */
export interface TelegramChannelOptions<E extends Env = Env> {
	/**
	 * The `secret_token` configured with Telegram's `setWebhook`.
	 *
	 * This is intentionally required even though Telegram makes it optional.
	 */
	secretToken: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives one verified Telegram Update per callback. */
	webhook(input: TelegramWebhookHandlerInput<E>): TelegramHandlerResult;
}

export interface TelegramUserRef {
	id: number;
	isBot: boolean;
	firstName: string;
	lastName?: string;
	username?: string;
	languageCode?: string;
}

export interface TelegramChatRef {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
	title?: string;
	username?: string;
	firstName?: string;
	lastName?: string;
}

/** Stable Telegram destination suitable for a Flue agent-instance id. */
export type TelegramConversationRef =
	| {
			type: 'chat';
			chatId: number;
			messageThreadId?: number;
			directMessagesTopicId?: number;
	  }
	| {
			type: 'business-chat';
			businessConnectionId: string;
			chatId: number;
			messageThreadId?: number;
			directMessagesTopicId?: number;
	  };

export interface TelegramCommand {
	name: string;
	botUsername?: string;
	arguments: string;
	raw: string;
}

export type TelegramMediaKind =
	| 'animation'
	| 'audio'
	| 'document'
	| 'live_photo'
	| 'paid_media'
	| 'photo'
	| 'sticker'
	| 'story'
	| 'video'
	| 'video_note'
	| 'voice';

export interface TelegramMessagePayload {
	messageId: number;
	date: number;
	chat: TelegramChatRef;
	from?: TelegramUserRef;
	senderChat?: TelegramChatRef;
	text?: string;
	caption?: string;
	command?: TelegramCommand;
	messageThreadId?: number;
	directMessagesTopicId?: number;
	businessConnectionId?: string;
	media: readonly TelegramMediaKind[];
}

export type TelegramMessageKind =
	| 'message'
	| 'edited_message'
	| 'channel_post'
	| 'edited_channel_post'
	| 'business_message'
	| 'edited_business_message'
	| 'guest_message';

/**
 * Short-lived capability for replying to a Telegram guest query.
 *
 * Never place this value in model context, logs, durable session data, or a
 * conversation key.
 */
export interface TelegramGuestCapabilities {
	guestQueryId: string;
}

export interface TelegramMessageUpdate {
	type: 'message';
	kind: TelegramMessageKind;
	updateId: number;
	message: TelegramMessagePayload;
	/**
	 * Omitted for guest messages because `guestQueryId` is a short-lived reply
	 * capability rather than a durable chat destination.
	 */
	conversation?: TelegramConversationRef;
	/** Present only for `guest_message` updates. */
	capabilities?: TelegramGuestCapabilities;
	/** Complete parsed Update after secret-token verification. */
	raw: unknown;
}

export interface TelegramCallbackQueryPayload {
	id: string;
	from: TelegramUserRef;
	chatInstance: string;
	data?: string;
	gameShortName?: string;
	inlineMessageId?: string;
	message?: TelegramMessagePayload;
}

export interface TelegramCallbackQueryUpdate {
	type: 'callback_query';
	updateId: number;
	callback: TelegramCallbackQueryPayload;
	conversation?: TelegramConversationRef;
	raw: unknown;
}

export interface TelegramMessageReactionUpdate {
	type: 'message_reaction';
	updateId: number;
	chat: TelegramChatRef;
	messageId: number;
	date: number;
	user?: TelegramUserRef;
	actorChat?: TelegramChatRef;
	oldReaction: readonly unknown[];
	newReaction: readonly unknown[];
	conversation: TelegramConversationRef;
	raw: unknown;
}

export interface TelegramMessageReactionCountUpdate {
	type: 'message_reaction_count';
	updateId: number;
	chat: TelegramChatRef;
	messageId: number;
	date: number;
	reactions: readonly unknown[];
	conversation: TelegramConversationRef;
	raw: unknown;
}

export interface TelegramUnknownUpdate {
	type: 'unknown';
	updateId: number;
	updateType: string;
	payload: unknown;
	raw: unknown;
}

export type TelegramUpdate =
	| TelegramMessageUpdate
	| TelegramCallbackQueryUpdate
	| TelegramMessageReactionUpdate
	| TelegramMessageReactionCountUpdate
	| TelegramUnknownUpdate;

type TelegramHandlerValue = undefined | JsonValue | Response;

export type TelegramHandlerResult =
	| TelegramHandlerValue
	| Promise<TelegramHandlerValue>;

export interface TelegramWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	update: TelegramUpdate;
}

/** Verified Telegram webhook ingress and canonical identity helpers. */
export interface TelegramChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: TelegramConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): TelegramConversationRef;
}

/**
 * Creates one verified Telegram Bot API webhook route.
 *
 * The channel is stateless and does not deduplicate `update_id` values.
 */
export function createTelegramChannel<E extends Env = Env>(
	options: TelegramChannelOptions<E>,
): TelegramChannel<E> {
	validateOptions(options);
	const channel: TelegramChannel<E> = {
		routes: [
			{
				method: 'POST',
				path: '/webhook',
				handler: createTelegramWebhookHandler(options),
			},
		],
		conversationKey(ref) {
			assertConversationRef(ref);
			const common = [
				'chat',
				encodeURIComponent(String(ref.chatId)),
				'thread',
				ref.messageThreadId === undefined ? '' : String(ref.messageThreadId),
				'direct',
				ref.directMessagesTopicId === undefined
					? ''
					: String(ref.directMessagesTopicId),
			];
			return ref.type === 'business-chat'
				? [
						'telegram',
						'v1',
						'business',
						encodeURIComponent(ref.businessConnectionId),
						...common,
					].join(':')
				: ['telegram', 'v1', 'regular', ...common].join(':');
		},
		parseConversationKey(id) {
			try {
				const business =
					/^telegram:v1:business:([^:]+):chat:([^:]+):thread:([^:]*):direct:([^:]*)$/.exec(
						id,
					);
				if (business?.[1] && business[2] && business[3] !== undefined && business[4] !== undefined) {
					const ref: TelegramConversationRef = {
						type: 'business-chat',
						businessConnectionId: decodeURIComponent(business[1]),
						chatId: parseIdentifier(business[2]),
						...optionalNumericIdentity('messageThreadId', business[3]),
						...optionalNumericIdentity('directMessagesTopicId', business[4]),
					};
					assertConversationRef(ref);
					if (channel.conversationKey(ref) !== id) {
						throw new InvalidTelegramConversationKeyError();
					}
					return ref;
				}

				const regular =
					/^telegram:v1:regular:chat:([^:]+):thread:([^:]*):direct:([^:]*)$/.exec(id);
				if (!regular?.[1] || regular[2] === undefined || regular[3] === undefined) {
					throw new InvalidTelegramConversationKeyError();
				}
				const ref: TelegramConversationRef = {
					type: 'chat',
					chatId: parseIdentifier(regular[1]),
					...optionalNumericIdentity('messageThreadId', regular[2]),
					...optionalNumericIdentity('directMessagesTopicId', regular[3]),
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidTelegramConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidTelegramConversationKeyError) throw error;
				throw new InvalidTelegramConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: TelegramChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new InvalidTelegramInputError('options');
	}
	if (
		typeof options.secretToken !== 'string' ||
		!/^[A-Za-z0-9_-]{1,256}$/.test(options.secretToken)
	) {
		throw new InvalidTelegramInputError('secretToken');
	}
	if (typeof options.webhook !== 'function') {
		throw new InvalidTelegramInputError('webhook');
	}
}

function assertConversationRef(ref: TelegramConversationRef): void {
	if (!ref || typeof ref !== 'object') {
		throw new InvalidTelegramInputError('conversation');
	}
	if (ref.type !== 'chat' && ref.type !== 'business-chat') {
		throw new InvalidTelegramInputError('conversation.type');
	}
	assertTelegramIdentifier(ref.chatId, 'conversation.chatId');
	if (ref.messageThreadId !== undefined) {
		assertPositiveInteger(ref.messageThreadId, 'conversation.messageThreadId');
	}
	if (ref.directMessagesTopicId !== undefined) {
		assertPositiveInteger(
			ref.directMessagesTopicId,
			'conversation.directMessagesTopicId',
		);
	}
	if (
		ref.messageThreadId !== undefined &&
		ref.directMessagesTopicId !== undefined
	) {
		throw new InvalidTelegramInputError('conversation.topic');
	}
	if (
		ref.type === 'business-chat' &&
		(typeof ref.businessConnectionId !== 'string' ||
			ref.businessConnectionId.length === 0)
	) {
		throw new InvalidTelegramInputError(
			'conversation.businessConnectionId',
		);
	}
}

function assertTelegramIdentifier(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value === 0) {
		throw new InvalidTelegramInputError(field);
	}
}

function assertPositiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new InvalidTelegramInputError(field);
	}
}

function parseIdentifier(value: string): number {
	const decoded = decodeURIComponent(value);
	if (!/^-?[1-9]\d*$/.test(decoded)) {
		throw new InvalidTelegramConversationKeyError();
	}
	const parsed = Number(decoded);
	if (!Number.isSafeInteger(parsed) || parsed === 0) {
		throw new InvalidTelegramConversationKeyError();
	}
	return parsed;
}

function optionalNumericIdentity<
	TKey extends 'messageThreadId' | 'directMessagesTopicId',
>(key: TKey, value: string): Partial<Record<TKey, number>> {
	if (value === '') return {};
	if (!/^[1-9]\d*$/.test(value)) {
		throw new InvalidTelegramConversationKeyError();
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new InvalidTelegramConversationKeyError();
	}
	return { [key]: parsed } as Partial<Record<TKey, number>>;
}
