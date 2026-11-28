import type { App, FileSystemAdapter } from 'obsidian';
import { useEffect, useRef, useState } from 'react';
import { readGeneratedPcmAsWave, resolveGeneratedMediaPath } from '../../orchestration/storage/generatedMedia';
import type { GeneratedMediaRef } from '../../types';
import { imagePreviewLabel, openImagePreview } from '../imagePreview';
import { tr } from '../skills/dialog';

function MediaPlayer({ kind, source, label, onError }: {
	kind: 'video' | 'audio'; source: string; label: string; onError: () => void;
}) {
	const player = useRef<HTMLMediaElement>(null);
	useEffect(() => {
		const element = player.current;
		return () => {
			if (!element) return;
			element.pause();
			element.removeAttribute('src');
			element.load();
		};
	}, []);
	const props = { className: 'scribe-chat-player', controls: true, preload: 'metadata',
		src: source, 'aria-label': label, onError, ref: (element: HTMLMediaElement | null) => { player.current = element; } };
	return kind === 'video' ? <video {...props} playsInline /> : <audio {...props} />;
}

function MediaPreview({ app, kind, path, sampleRate }: GeneratedMediaRef & { app: App }) {
	const [source, setSource] = useState<string | null>();
	const closeImage = useRef<() => void>(undefined);
	useEffect(() => {
		const adapter = app.vault.adapter as FileSystemAdapter;
		let active = true;
		let previewUrl: string | undefined;
		const media = { kind, path, sampleRate };
		const resolve = async () => {
			if (kind === 'audio' && /\.pcm$/iu.test(path)) {
				const wave = await readGeneratedPcmAsWave(adapter.getBasePath(), app.vault.configDir, media);
				if (!active) return;
				previewUrl = URL.createObjectURL(new Blob([wave], { type: 'audio/wav' }));
				setSource(previewUrl);
				return;
			}
			await resolveGeneratedMediaPath(adapter.getBasePath(), app.vault.configDir, media);
			if (active) setSource(adapter.getResourcePath(path));
		};
		void resolve().catch(() => {
			if (active) setSource(null);
		});
		return () => {
			active = false;
			closeImage.current?.();
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [app, kind, path, sampleRate]);
	if (source === undefined) return null;
	const label = path.split('/').at(-1) ?? path;
	if (!source) return <span className="scribe-chat-media-error" role="status">
		{tr(`无法打开媒体文件 ${label}。`, `Could not open media file ${label}.`)}
	</span>;
	if (kind !== 'image') return <MediaPlayer kind={kind} source={source} label={label} onError={() => setSource(null)} />;
	return <button type="button" className="scribe-generated-image-preview" aria-label={`${imagePreviewLabel()} · ${label}`}
		onClick={({ currentTarget }) => {
			closeImage.current?.();
			closeImage.current = openImagePreview(app, source, label, currentTarget);
		}}>
		<img className="scribe-chat-zoomable" src={source} alt={label} loading="lazy" onError={() => setSource(null)} />
	</button>;
}

export default function GeneratedMedia({ app, media }: { app: App; media: readonly GeneratedMediaRef[] }) {
	return <div className="scribe-generated-media">
		{media.map((item) => <MediaPreview key={`${item.kind}:${item.path}`} app={app} {...item} />)}
	</div>;
}
