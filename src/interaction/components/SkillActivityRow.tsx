import { useEffect, useMemo, useState } from 'react';
import { parseSkillReadReceipt, skillReadName } from '../../skills/readReceipt';
import type { SkillReadReceipt } from '../../skills/readReceipt';
import type { RunStatus, ToolCall, ToolResult } from '../../types';
import { toolTextField } from '../toolCardDetails';
import { uiText } from '../uiText';
import ActivityDisclosure from './ActivityDisclosure';
import ChatIcon from './ChatIcon';

const stateIcons = {
	running: 'loader-circle',
	waiting: 'clock',
	success: 'check',
	error: 'x',
	skipped: 'circle-stop',
	stopped: 'circle-stop',
};

export function SkillActivityRow({
	call, result, status = 'running', skipped, expanded, onToggle, load,
}: {
	call: ToolCall; result?: ToolResult; status?: RunStatus; skipped?: boolean;
	expanded: boolean; onToggle: () => void; load: (receipt: SkillReadReceipt) => Promise<string>;
}) {
	const text = uiText();
	const resultText = result?.content;
	const resultId = result?.callId;
	const failed = result?.isError;
	const saved = useMemo(() => {
		if (!resultText || failed || skipped || resultId !== call.id) return;
		const receipt = parseSkillReadReceipt(resultText);
		return receipt ? { receipt, name: skillReadName(resultText, receipt) } : undefined;
	}, [resultText, resultId, call.id, failed, skipped]);
	const receipt = saved?.receipt;
	const [view, setView] = useState<{ receipt: SkillReadReceipt; content?: string }>();

	useEffect(() => {
		if (!expanded || !receipt) {
			setView(undefined);
			return;
		}
		let current = true;
		void load(receipt).then((content) => {
			if (current) setView({ receipt, content });
		}, () => {
			if (current) setView({ receipt });
		});
		return () => { current = false; };
	}, [expanded, load, receipt]);

	const file = receipt?.file ?? toolTextField(call.input, 'file') ?? 'SKILL.md';
	const resource = file !== 'SKILL.md';
	const state = skipped ? 'skipped' : result ? failed ? 'error' : 'success'
		: status === 'awaiting-approval' ? 'waiting' : status === 'running' ? 'running' : 'stopped';
	const labels = {
		running: text.chatSkillReading, waiting: text.chatSkillReading,
		error: text.chatSkillFailed, skipped: text.chatToolSkipped, stopped: text.chatInterrupted,
		success: (resource ? text.chatSkillResourceRead : text.chatSkillLoaded).replace('{name}', () => saved?.name ?? text.chatSkillUnknown),
	};
	const label = labels[state];
	const body = view?.receipt === receipt ? view : undefined;
	const content = state === 'error' || state === 'skipped' ? resultText || undefined : body?.content;
	const contentLabel = resource ? text.chatSkillResource : text.chatSkillContent;
	const pending = state === 'success' && receipt && !body;
	const instruction = toolTextField(call.input, 'intent') ?? toolTextField(call.input, 'i');
	return (
		<ActivityDisclosure className="scribe-tool-card scribe-skill-activity" state={state} icon="book-open"
			label={label} expanded={expanded} onToggle={onToggle}
			end={<span className="scribe-tool-status" aria-hidden="true"><ChatIcon name={stateIcons[state]} /></span>}>
			<div className="scribe-tool-body">
				<section aria-label={contentLabel}>
					{content !== undefined
						? <pre className="scribe-chat-pre" tabIndex={0} aria-label={contentLabel}>{content}</pre>
						: <span className="scribe-skill-caption" role="status">{state === 'success'
							? pending ? text.chatSkillReading : text.chatSkillUnavailable : label}</span>}
				</section>
				<section aria-label={text.chatSkillTask}>
					{instruction
						? <pre className="scribe-chat-pre" tabIndex={0} aria-label={text.chatSkillTask}>{instruction}</pre>
						: <span className="scribe-skill-caption">{text.chatSkillNoTask}</span>}
				</section>
			</div>
		</ActivityDisclosure>
	);
}
