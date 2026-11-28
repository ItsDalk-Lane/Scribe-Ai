import { isArkVideoId } from '../../communication/arkVisual';
import { normalizeMediaDirectory } from '../settings/mediaSettings';
import { isGeneratedMediaRef, isGeneratedVideoJobId } from './paths';
import type { GeneratedMediaRef } from '../../types';
import type { MediaJobRoute } from '../settings/mediaConnection';

export const VIDEO_JOBS_SUFFIX = '.media-videos.json';
export const VIDEO_JOBS_LIMIT = 2 * 1024 * 1024;
export type VideoJobState = 'submitting' | 'queued' | 'running' | 'downloading' | 'ready' | 'failed' | 'unknown' | 'paused';

export interface SavedVideoJob {
	id: string;
	state: VideoJobState;
	credential?: string;
	remoteId?: string;
	directory?: string;
	requested?: string;
	requestKey?: string;
	pendingMedia?: GeneratedMediaRef;
	media?: GeneratedMediaRef;
	error?: string;
	detail?: string;
	route?: MediaJobRoute;
}

export interface VideoJobHistory {
	list(id: string): Promise<SavedVideoJob[]>;
	save(id: string, job: SavedVideoJob): Promise<void>;
	conversationIds(): Promise<string[]>;
}

const states: VideoJobState[] = ['submitting', 'queued', 'running', 'downloading', 'ready', 'failed', 'unknown', 'paused'];
const text = (value: unknown, limit: number) => value === undefined || (typeof value === 'string' && value.length <= limit);
const digest = (value: unknown) => value === undefined || (typeof value === 'string' && /^[a-f\d]{64}$/u.test(value));
const video = (value: unknown) => isGeneratedMediaRef(value) && value.kind === 'video' && /\.mp4$/iu.test(value.path);
const route = (value: MediaJobRoute | undefined) => value === undefined || (value && typeof value === 'object'
	&& typeof value.providerId === 'string' && /^[a-z0-9-]{1,128}$/iu.test(value.providerId)
	&& typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 256
	&& (value.operation === 'video' || value.operation === 'video-edit'));
export function validRemoteVideoId(id: unknown, external: boolean): id is string {
	return external ? typeof id === 'string' && /^[a-z\d_.:/=-]{1,4096}$/iu.test(id) : isArkVideoId(id);
}

export function isSavedVideoJob(value: unknown): value is SavedVideoJob {
	if (!value || typeof value !== 'object') return false;
	const job = value as Partial<SavedVideoJob>;
	let safeDirectory = false;
	try { safeDirectory = job.directory === undefined || normalizeMediaDirectory(job.directory) === job.directory; }
	catch { return false; }
	return isGeneratedVideoJobId(job.id) && job.state !== undefined && states.includes(job.state)
		&& digest(job.credential) && digest(job.requestKey)
		&& route(job.route) && (job.remoteId === undefined || (validRemoteVideoId(job.remoteId, Boolean(job.route)) && job.credential !== undefined)) && safeDirectory
		&& text(job.requested, 200) && text(job.error, 400) && text(job.detail, 400)
		&& (job.state === 'ready' ? video(job.media) : job.media === undefined)
		&& (job.pendingMedia === undefined || (video(job.pendingMedia) && job.remoteId !== undefined));
}

export function parseVideoJobs(source: string, conversationId: string): SavedVideoJob[] {
	const value = JSON.parse(source) as { conversationId?: unknown; jobs?: unknown } | null;
	if (value?.conversationId !== conversationId || !Array.isArray(value.jobs) || !value.jobs.every(isSavedVideoJob)) {
		throw new Error('视频生成记录格式无效。');
	}
	return value.jobs;
}
