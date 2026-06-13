import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/telegram.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound Telegram conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
