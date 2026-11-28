import type { App } from 'obsidian';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { imagePreviewLabel, openImagePreview } from '../imagePreview';

function markThumbnail(button: HTMLButtonElement | null) {
	const chip = button?.parentElement;
	if (!chip) return;
	chip.classList.add('has-thumbnail');
	return () => chip.classList.remove('has-thumbnail');
}

export default function PastedImageThumbnail({ app, source, label, fallback }: {
	app: App; source: string; label: string; fallback: ReactNode;
}) {
	const [failed, setFailed] = useState(false);
	const closePreview = useRef<() => void>(undefined);
	useEffect(() => () => closePreview.current?.(), []);
	if (failed) return <>{fallback}</>;
	return <button type="button" ref={markThumbnail} className="scribe-pasted-image-button" aria-label={`${imagePreviewLabel()} · ${label}`}
		onClick={({ currentTarget }) => {
			closePreview.current?.();
			closePreview.current = openImagePreview(app, source, label, currentTarget);
		}}>
		<img src={source} alt={label} onError={() => setFailed(true)} />
	</button>;
}
