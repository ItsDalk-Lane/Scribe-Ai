import { uiText } from '../uiText';
import JumpNavigator from './JumpNavigator';

interface Entry {
	id: string;
	prompt: string;
	reply: string;
}

export default function TurnNavigator({
	entries, current, onJump,
}: { entries: Entry[]; current?: string; onJump: (id: string) => void }) {
	const text = uiText();
	const turns = entries.map((entry, index) => {
		const turn = text.chatJumpToTurn.replace('{n}', (index + 1).toLocaleString());
		return { ...entry, turn, label: [turn, entry.prompt].filter(Boolean).join(' · ') };
	});
	return <JumpNavigator entries={turns} current={current} label={text.chatTurnNavigator} onJump={onJump}
		renderListLabel={({ prompt, reply, turn }) => <><span>{prompt || turn}</span>{reply && <span>{reply}</span>}</>}
		renderPreview={({ prompt, reply, turn }, choose) => (prompt || reply) && <button type="button"
			className="scribe-turn-preview-action" tabIndex={-1} aria-label={turn} onClick={choose}>
			{prompt && <span>{prompt}</span>}
			{reply && <span className="scribe-turn-preview-reply">{reply}</span>}
		</button>} />;
}
