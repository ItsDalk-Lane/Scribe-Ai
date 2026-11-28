import { setTimeout as wait } from 'node:timers/promises';
import { ArkHttpError, authorizedArkFetch, boundedMedia, createArkVideo, downloadArkMedia, queryArkVideo } from '../communication/arkVisual';
import type { ArkFetch } from '../communication/arkVisual';
import { MediaHttpError } from '../communication/mediaApi';
import type { MediaCall } from '../communication/mediaApi';
import { MissingConversationError } from '../types';
import { publishMediaOutput, saveGeneratedMedia } from '../tools/support/generatedMediaFiles';
import type { MediaDestination } from '../tools/support/generatedMediaFiles';
import type { VideoOptions } from './settings/mediaSettings';
import { validRemoteVideoId, type SavedVideoJob, type VideoJobHistory } from './storage/mediaVideoRecords';
import { guardedMediaFetch, type MediaJobRoute, type mediaConnection } from './settings/mediaConnection';
import { resolveGeneratedMediaPath } from './storage/generatedMedia';
import { hasFileErrorCode } from '../tools/support/pathUtils';

const pollMs = 5_000;
const pauseMs = 15 * 60_000;

interface VideoConnection { identity: string; key: string }

export function createMediaVideoJobs(options: {
	history: VideoJobHistory;
	fetcher: ArkFetch;
	connection: () => VideoConnection | undefined;
	externalConnection?: (route: MediaJobRoute) => ReturnType<typeof mediaConnection>;
	cwd: string;
	configDir: string;
	intervalMs?: number;
	download?: typeof downloadArkMedia;
}) {
	const { history, fetcher, cwd, configDir } = options;
	const lifetime = new AbortController();
	const polling = new Map<string, Map<string, AbortController>>();
	const changes = new Map<string, Set<() => void>>();
	const submitting = new Set<string>();
	const recovering = new Map<string, Promise<void>>();
	const removed = new Set<string>();

	async function update(conversationId: string, previous: SavedVideoJob, values?: Partial<SavedVideoJob>) {
		if (removed.has(conversationId)) throw new MissingConversationError('对话已删除。');
		const job = { ...previous, ...values };
		await history.save(conversationId, job);
		changes.get(conversationId)?.forEach((listener) => listener());
		return job;
	}

	function currentConnection(job: SavedVideoJob) {
		return job.route ? options.externalConnection?.(job.route) : options.connection();
	}

	function track(conversationId: string, saved: SavedVideoJob) {
		const remoteId = saved.remoteId;
		if (!remoteId || saved.state === 'ready' || saved.state === 'failed' || lifetime.signal.aborted || removed.has(conversationId)) return;
		const active = polling.get(conversationId) ?? new Map<string, AbortController>();
		if (active.has(saved.id)) return;
		const controller = new AbortController();
		active.set(saved.id, controller);
		polling.set(conversationId, active);
		const signal = AbortSignal.any([controller.signal, lifetime.signal]);
		void (async () => {
			let job = saved;
			const start = Date.now();
			try {
				if (job.pendingMedia) {
					const media = job.pendingMedia;
					const exists = await resolveGeneratedMediaPath(cwd, configDir, media).then(() => true, (error: unknown) => {
						if (hasFileErrorCode(error, 'ENOENT')) return false;
						throw error;
					});
					signal.throwIfAborted();
					if (exists) {
						await update(conversationId, job, { state: 'ready', media, pendingMedia: undefined, remoteId: undefined, credential: undefined, error: undefined });
						return;
					}
				}
				for (;;) {
					signal.throwIfAborted();
					const connection = currentConnection(job);
					if (!connection || connection.identity !== job.credential) {
						if (job.state !== 'paused') await update(conversationId, job, { state: 'paused', error: '原视频连接已停用或密钥已变更。' });
						return;
					}
					if (Date.now() - start > pauseMs) {
						await update(conversationId, job, { state: 'paused', error: '等待视频生成已超时。可继续查询同一任务。' });
						return;
					}
					const confirm = () => {
						signal.throwIfAborted();
						if (currentConnection(job)?.identity !== connection.identity) throw new Error('原视频连接已变更。');
					};
					if (job.route && 'endpoint' in connection) {
						const active = connection as NonNullable<ReturnType<typeof mediaConnection>>;
						if (!active.adapter.poll) throw new Error('当前连接无法继续查询原视频任务。');
						const poll: MediaCall = { ...active, model: job.route.model, prompt: '', options: {},
							signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
							fetch: guardedMediaFetch(fetcher, active.endpoint, confirm) };
						const reply = await active.adapter.poll(poll, remoteId);
						confirm();
						if (reply.status === 'succeeded') {
							job = await update(conversationId, job, { state: 'downloading', error: undefined });
							const media = await publishMediaOutput({ cwd, configDir, conversationId, directory: job.directory }, 'video', reply.result,
								AbortSignal.any([signal, AbortSignal.timeout(180_000)]), async (pendingMedia) => {
									confirm();
									job = await update(conversationId, job, { pendingMedia });
								});
							signal.throwIfAborted();
							await update(conversationId, job, { state: 'ready', media, pendingMedia: undefined, remoteId: undefined, credential: undefined });
							return;
						}
						if (reply.status === 'failed') {
							await update(conversationId, job, { state: 'failed', error: '服务商未能完成视频任务。', remoteId: undefined, credential: undefined });
							return;
						}
						if (reply.status !== job.state) job = await update(conversationId, job, { state: reply.status, error: undefined });
						await wait(options.intervalMs ?? pollMs, undefined, { signal });
						continue;
					}
					const guardedFetch = authorizedArkFetch(fetcher, confirm);
					const reply = await queryArkVideo(guardedFetch, connection.key, remoteId, AbortSignal.any([signal, AbortSignal.timeout(25_000)]));
					signal.throwIfAborted();
					if (options.connection()?.identity !== connection.identity) {
						await update(conversationId, job, { state: 'paused', error: '原方舟视频连接已变更。' });
						return;
					}
					if (reply.status === 'queued' || reply.status === 'running') {
						if (job.state !== reply.status) job = await update(conversationId, job, { state: reply.status, error: undefined });
					} else if (reply.status === 'succeeded') {
						const detail = [reply.duration !== undefined ? `${reply.duration} 秒` : '', reply.resolution,
							reply.tokens !== undefined ? `${reply.tokens} 生成 token` : ''].filter(Boolean).join(' · ');
						job = await update(conversationId, job, { state: 'downloading', detail, error: undefined });
						const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
						const { body, limit } = await (options.download ?? downloadArkMedia)(reply.url, 'video', downloadSignal);
						const media = await saveGeneratedMedia({ cwd, configDir, conversationId, directory: job.directory }, 'video', 'mp4',
							boundedMedia(body, limit, downloadSignal), downloadSignal, async (pendingMedia) => {
								job = await update(conversationId, job, { pendingMedia });
							});
						signal.throwIfAborted();
						await update(conversationId, job, { state: 'ready', media, pendingMedia: undefined, remoteId: undefined, credential: undefined });
						return;
					} else {
						const error = reply.status === 'expired' ? '方舟视频任务已过期。'
							: reply.status === 'cancelled' ? '方舟已取消视频任务。' : '方舟未能生成视频。';
						await update(conversationId, job, { state: 'failed', error, pendingMedia: undefined, remoteId: undefined, credential: undefined });
						return;
					}
					await wait(options.intervalMs ?? pollMs, undefined, { signal });
				}
			} catch (error) {
				if (signal.aborted || error instanceof MissingConversationError) return;
				const missing = (error instanceof ArkHttpError || error instanceof MediaHttpError) && error.status === 404;
				await update(conversationId, job, missing
					? { state: 'failed', error: '服务商已无法查询此视频任务。', pendingMedia: undefined, remoteId: undefined, credential: undefined }
					: { state: 'paused', error: job.state === 'downloading' ? '视频下载未完成，可重新查询后下载。' : '查询视频进度失败，可继续查询同一任务。' });
			} finally {
				active.delete(saved.id);
				if (!active.size && polling.get(conversationId) === active) polling.delete(conversationId);
			}
		})().catch(() => {});
	}

	function recover(conversationId: string) {
		const existing = recovering.get(conversationId);
		if (existing) return existing;
		const recovery = (async () => {
			for (const job of await history.list(conversationId)) {
				if (lifetime.signal.aborted || removed.has(conversationId)) break;
				if (job.state === 'submitting' && !submitting.has(conversationId + job.id)) {
					await update(conversationId, job, { state: 'unknown', error: '未收到服务商任务编号，请核对服务商记录再决定是否重新生成。' });
				} else track(conversationId, job);
			}
		})().finally(() => recovering.delete(conversationId));
		recovering.set(conversationId, recovery);
		return recovery;
	}

	async function submitVideo(destination: MediaDestination, id: string, connection: VideoConnection, requested: string,
		confirm: () => void, send: () => Promise<string>, requestKey?: string, route?: MediaJobRoute, wasSent?: () => boolean) {
		const { conversationId, directory } = destination;
		const key = conversationId + id;
		if (submitting.has(key)) throw new Error('这个视频任务正在提交。');
		submitting.add(key);
		try {
			const jobs = await history.list(conversationId);
			const found = jobs.find((job) => job.id === id) ?? jobs.find((job) => requestKey && job.requestKey === requestKey && job.state === 'unknown');
			if (found) return found;
			confirm();
			let job = await update(conversationId, { id, state: 'submitting', credential: connection.identity, directory, requested, requestKey, route });
			try { confirm(); }
			catch { return await update(conversationId, job, { state: 'failed', error: '设置或权限已变化，本次没有发送。' }); }
			try {
				const remoteId = await send();
				if (!validRemoteVideoId(remoteId, Boolean(route))) throw new Error('服务返回了无效的视频任务编号。');
				job = await update(conversationId, job, { remoteId, state: 'queued' });
			} catch (error) {
				if (wasSent && !wasSent()) return await update(conversationId, job, { state: 'failed', error: '本次没有发出视频请求，请检查素材或模型设置。' });
				const rejected = (error instanceof ArkHttpError || error instanceof MediaHttpError) && error.status >= 400 && error.status < 500;
				return await update(conversationId, job, rejected
					? { state: 'failed', error: error.message } : { state: 'unknown', error: '未收到服务商任务编号，请核对服务商记录再决定是否重新生成。' });
			}
			track(conversationId, job);
			return job;
		} finally { submitting.delete(key); }
	}

	return {
		list: (conversationId: string) => history.list(conversationId),
		subscribe(conversationId: string, listener: () => void) {
			const subscribers = changes.get(conversationId) ?? new Set();
			subscribers.add(listener);
			changes.set(conversationId, subscribers);
			return () => {
				subscribers.delete(listener);
				if (!subscribers.size) changes.delete(conversationId);
			};
		},
		recover,
		async recoverAll() {
			for (const id of await history.conversationIds()) {
				if (lifetime.signal.aborted) break;
				await recover(id).catch(() => {});
			}
		},
		async submit(destination: MediaDestination, id: string, connection: VideoConnection, model: string, prompt: string,
			parameters: VideoOptions, reference: string | undefined, requested: string, signal: AbortSignal, confirm: () => void, requestKey?: string) {
			return submitVideo(destination, id, connection, requested, confirm, () =>
				createArkVideo(authorizedArkFetch(fetcher, confirm), connection.key, model, prompt, parameters, reference,
					AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(45_000)])), requestKey);
		},
		submitExternal(destination: MediaDestination, id: string, connection: VideoConnection, route: MediaJobRoute,
			signal: AbortSignal, confirm: () => void, requestKey: string, send: () => Promise<string>, wasSent?: () => boolean) {
			const check = () => { signal.throwIfAborted(); lifetime.signal.throwIfAborted(); confirm(); };
			return submitVideo(destination, id, connection, route.model, check, send, requestKey, route, wasSent);
		},
		forget(conversationId: string) {
			removed.add(conversationId);
			for (const controller of polling.get(conversationId)?.values() ?? []) controller.abort();
			polling.delete(conversationId);
		},
		restore(conversationId: string) {
			removed.delete(conversationId);
			void recover(conversationId).catch(() => {});
		},
		dispose() { lifetime.abort(); },
	};
}

export type MediaVideoJobs = ReturnType<typeof createMediaVideoJobs>;
