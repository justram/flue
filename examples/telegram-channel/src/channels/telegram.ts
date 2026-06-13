import {
	createTelegramChannel,
	type TelegramConversationRef,
} from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import assistant from '../agents/assistant.ts';

export const client = new Api(requiredEnv('TELEGRAM_BOT_TOKEN'));

export const channel = createTelegramChannel({
	secretToken: requiredEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN'),

	// Path: /channels/telegram/webhook
	async webhook({ update }) {
		switch (update.type) {
			case 'message': {
				if (
					!update.conversation ||
					(update.kind !== 'message' &&
						update.kind !== 'business_message' &&
						update.kind !== 'channel_post')
				) {
					return;
				}
				await dispatch(assistant, {
					id: channel.conversationKey(update.conversation),
					input: {
						type: `telegram.${update.kind}`,
						updateId: update.updateId,
						message: update.message,
					},
				});
				return;
			}
			case 'callback_query': {
				await client.answerCallbackQuery(update.callback.id);
				if (!update.conversation) return;
				await dispatch(assistant, {
					id: channel.conversationKey(update.conversation),
					input: {
						type: 'telegram.callback_query',
						updateId: update.updateId,
						data: update.callback.data,
						from: update.callback.from,
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function postMessage(ref: TelegramConversationRef) {
	return defineTool({
		name: 'post_telegram_message',
		description: 'Post a message to the Telegram conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const message = await client.sendMessage(ref.chatId, text, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId === undefined
					? {}
					: { message_thread_id: ref.messageThreadId }),
				...(ref.directMessagesTopicId === undefined
					? {}
					: { direct_messages_topic_id: ref.directMessagesTopicId }),
			});
			return JSON.stringify({ messageId: message.message_id });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
