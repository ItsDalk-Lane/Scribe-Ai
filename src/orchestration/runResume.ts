import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRequest, ResumeReview, RunCheckpoint, RunObserver, SavedRun, TaskRequest } from '../types';

export const pauseRun = Symbol('pause run');

export class ResumeThinkingUnavailable extends Error {
	constructor(readonly level: ModelThinkingLevel) {
		super(`Saved thinking level is unavailable: ${level}`);
	}
}

export function canResumeRun(run: SavedRun | undefined): run is SavedRun {
	return Boolean(run && !run.finalized && run.state.status === 'interrupted'
		&& (run.step?.phase !== 'tool' || run.state.pendingCalls.length === 0));
}

export function createResumeReview(
	source: TaskRequest,
	confirm: NonNullable<RunObserver['confirmResume']>,
	signal: AbortSignal,
	checkModel: () => void,
	save: (event: RunCheckpoint) => Promise<void>,
) {
	const cancelled = new AbortController();
	const reviewSignal = AbortSignal.any([signal, cancelled.signal]);
	const checkpoints: RunCheckpoint[] = [];
	let request: ModelRequest | undefined;
	let address: string | undefined;
	let decision: Promise<void> | undefined;
	let approved = false;

	const review: ResumeReview = {
		prepare(input) { request = input; },
		async beforeSend(destination) {
			reviewSignal.throwIfAborted();
			checkModel();
			if (address !== undefined && destination !== address) {
				throw new Error('续做的发送地址已改变，请重新确认。');
			}
			if (!decision) {
				if (!request) throw new Error('无法确认续做请求。');
				address = destination;
				const preview = { address, request, source };
				decision = (async () => {
					if (!await confirm(preview, reviewSignal)) cancelled.abort(pauseRun);
					reviewSignal.throwIfAborted();
					checkModel();
					// 只有确认发送后才提交续做进度，关闭确认不会推进或结束原任务。
					for (const event of checkpoints) await save(event);
					checkpoints.length = 0;
					approved = true;
				})();
			}
			await decision;
			reviewSignal.throwIfAborted();
			checkModel();
		},
	};
	return {
		signal: reviewSignal,
		review,
		get approved() { return approved; },
		async record(event: RunCheckpoint) {
			if (approved) await save(event);
			else checkpoints.push(event);
		},
	};
}
