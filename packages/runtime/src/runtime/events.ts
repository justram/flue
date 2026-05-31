/** Global, isolate-scoped subscription to live Flue runtime activity. */

import type { FlueContext, FlueEvent } from '../types.ts';

/**
 * Receives a decorated event and its originating context. Workflow events may
 * carry `runId`; direct and dispatched agent events carry `instanceId` and
 * optional `dispatchId` without becoming workflow runs. Synchronous subscriber
 * failures are logged and do not halt dispatch or the originating execution.
 */
export type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void;

// TODO: Isolate observers from persisted event objects and handle async callback rejections without adding backpressure.
const subscribers = new Set<FlueEventSubscriber>();

/**
 * Subscribe to live workflow-run or agent-interaction activity emitted in this isolate.
 * The subscription does not replay durable workflow history or aggregate events
 * across processes or Cloudflare Durable Object isolates.
 *
 * Usage (typically at the top of `app.ts`):

 *
 *     import { observe } from '@flue/runtime/app';
 *
 *     observe((event, ctx) => {
 *       if (event.type === 'run_end' && event.isError) {
 *         // ship to your error reporter, metrics sink, etc.
 *       }
 *     });
 *
 * The returned function unsubscribes the listener. Most error
 * reporting and telemetry use cases register once at startup and
 * never unsubscribe — the returned function is provided for tests
 * and dynamic-wiring scenarios.
 *
 * Subscribers are invoked synchronously from the event emit path.
 * They should be cheap and side-effect-only; do not block, do not
 * throw, do not mutate the event. Queue async work with application-owned
 * rejection handling rather than awaiting it.
 */
export function observe(subscriber: FlueEventSubscriber): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/**
 * Internal: dispatch a single event to every registered subscriber.
 * Called from `createFlueContext`'s `emitEvent` after the per-context
 * subscribers have run.
 */
export function dispatchGlobalEvent(event: FlueEvent, ctx: FlueContext): void {
	if (subscribers.size === 0) return;
	// Snapshot to a local array so subscribers that unsubscribe
	// themselves mid-dispatch don't perturb the iteration.
	for (const subscriber of [...subscribers]) {
		try {
			subscriber(event, ctx);
		} catch (error) {
			console.error('[flue:observe] subscriber threw:', error);
		}
	}
}
