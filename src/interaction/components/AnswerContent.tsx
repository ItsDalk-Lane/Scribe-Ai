import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { memo } from 'react';
import { renderAnswerMarkdown } from '../answerMarkdown';
import { resolveNoteCitation } from '../noteCitations';
import type { NoteCitation } from '../noteCitations';
import { uiText } from '../uiText';

async function openCitation(app: App, citation: NoteCitation): Promise<void> {
	const file = resolveNoteCitation(app.vault, citation);
	if (!file) throw new Error(uiText().chatCitationUnavailable);
	const leaf = app.workspace.getLeaf('tab');
	await leaf.openFile(file, {
		active: true,
		eState: citation.subpath ? { subpath: citation.subpath } : undefined,
	});
}

export default memo(function AnswerContent({ app, content }: { app: App; content: string }) {
	return (
		<div className="scribe-chat-content scribe-answer-markdown">
			{renderAnswerMarkdown(content, (part, index) => {
				const file = resolveNoteCitation(app.vault, part);
				if (!file) return part.raw;
				const destination = file.path + part.subpath;
				return (
					<button
						key={index}
						type="button"
						className="scribe-note-citation"
						title={destination}
						aria-label={destination}
						onClick={() => void openCitation(app, part).catch(() => new Notice(uiText().chatCitationUnavailable))}
					>
						{file.basename}
					</button>
				);
			})}
		</div>
	);
});
