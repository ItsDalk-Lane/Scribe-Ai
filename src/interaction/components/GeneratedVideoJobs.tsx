import type { App } from 'obsidian';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { SavedVideoJob } from '../../orchestration/storage/mediaVideoRecords';
import { tr } from '../skills/dialog';
import GeneratedMedia from './GeneratedMedia';

interface VideoJobService {
	list(conversationId: string): Promise<SavedVideoJob[]>;
	subscribe(conversationId: string, listener: () => void): () => void;
	recover(conversationId: string): Promise<void>;
}

export const GeneratedVideoJobsContext = createContext<{ jobs?: SavedVideoJob[]; recover(): Promise<void> } | undefined>(undefined);

export function GeneratedVideoJobsProvider({ conversationId, service, children }: {
	conversationId: string; service?: VideoJobService; children: ReactNode;
}) {
	const [snapshot, setSnapshot] = useState<{ conversationId: string; jobs: SavedVideoJob[] }>();
	useEffect(() => {
		if (!service) return;
		let active = true;
		let revision = 0;
		const refresh = () => {
			const current = ++revision;
			void service.list(conversationId).then((jobs) => {
				if (active && current === revision) setSnapshot({ conversationId, jobs });
			}).catch(() => {});
		};
		const unsubscribe = service.subscribe(conversationId, refresh);
		refresh();
		void service.recover(conversationId).catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [conversationId, service]);
	return <GeneratedVideoJobsContext.Provider value={service && {
		jobs: snapshot?.conversationId === conversationId ? snapshot.jobs : undefined,
		recover: () => service.recover(conversationId),
	}}>{children}</GeneratedVideoJobsContext.Provider>;
}

export function GeneratedVideoJobCard({ app, id }: { app: App; id: string }) {
	const context = useContext(GeneratedVideoJobsContext);
	const [checking, setChecking] = useState(false);
	const [failed, setFailed] = useState(false);
	const job = context?.jobs?.find((candidate) => candidate.id === id);
	if (!job) return context?.jobs ? <p className="scribe-chat-media-error" role="status">
		{tr('未找到这项视频任务的记录。', 'The saved video job could not be found.')}
	</p> : null;
	const label = {
		submitting: tr('正在提交视频任务', 'Submitting video job'),
		queued: tr('视频生成排队中', 'Video generation queued'),
		running: tr('正在生成视频', 'Generating video'),
		downloading: tr('正在下载视频', 'Downloading video'),
		ready: tr('视频已生成', 'Video generated'),
		failed: tr('视频生成失败', 'Video generation failed'),
		unknown: tr('未能确认视频任务是否已提交', 'Could not confirm whether the video job was submitted'),
		paused: tr('视频任务查询已暂停', 'Video job checks paused'),
	}[job.state];
	const canRecover = job.state === 'paused' && Boolean(job.remoteId);
	return <section className="scribe-generated-video-job" aria-label={label}>
		<div role="status">
			<strong>{label}</strong>
			{(job.error || job.detail) && <div>{job.error || job.detail}</div>}
			{canRecover && failed && <div>{tr('暂时无法查询视频任务。', 'Could not check the video job.')}</div>}
		</div>
		{job.media && <GeneratedMedia app={app} media={[job.media]} />}
		{canRecover && <button type="button" disabled={checking} onClick={() => {
			if (!context) return;
			setChecking(true);
			setFailed(false);
			void context.recover().catch(() => setFailed(true)).finally(() => setChecking(false));
		}}>{tr('继续查询', 'Resume checking')}</button>}
	</section>;
}

export function UnlinkedGeneratedVideoJobs({ app, linkedJobIds }: { app: App; linkedJobIds: ReadonlySet<string> }) {
	const jobs = useContext(GeneratedVideoJobsContext)?.jobs;
	return jobs?.filter(({ id }) => !linkedJobIds.has(id)).map(({ id }) => <GeneratedVideoJobCard app={app} id={id} key={id} />) ?? null;
}
