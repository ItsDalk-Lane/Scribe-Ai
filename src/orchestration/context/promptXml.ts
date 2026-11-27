import type { Message } from '../../types';

const tags = [
	'system-prompt', 'project-context', 'session-context', 'system-reminder', 'project-rules',
	'skill-instructions', 'approved-plan', 'memory-index', 'reference-material',
	'available-skills', 'available-subagents', 'mcp-context', 'session-snapshot',
	'user-request', 'selected-material', 'quoted-conversation', 'goal-context',
	'subagent-assignment', 'subagent-state', 'collaboration-update',
] as const;

export type PromptSection = { tag: Exclude<(typeof tags)[number], 'system-prompt'>; text: string; scopePath?: string };
const reserved = new RegExp(`<(?=\\/?(?:${tags.join('|')})(?:[\\s/>]|$))`, 'giu');

export function xmlText(text: string): string {
	return text.replace(/\p{Cc}/gu, (character) => '\t\n\r'.includes(character) ? character : '\uFFFD')
		.replace(/[\uD800-\uDFFF\uFFFE\uFFFF]/gu, '\uFFFD')
		.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function systemXml(sections: Record<string, string>, literalSection?: string): string {
	return '<system-prompt>\n' + Object.entries(sections)
		.map(([tag, value]) => `<${tag}>\n${tag === literalSection
			? '<![CDATA[\n' + value.replaceAll(']]>', ']]]]><![CDATA[>') + '\n]]>'
			: xmlText(value)}\n</${tag}>`).join('\n') + '\n</system-prompt>';
}

export function neutralizePromptTags(text: string): string {
	return text.replace(reserved, '&lt;');
}

export function promptText(message: Message): string {
	const { content, taskPrompt } = message;
	const sections: PromptSection[] = [];
	if (taskPrompt && message.role === 'user') {
		const { instruction, references, quotes, assignment, approvedPlan } = taskPrompt;
		const referenceEnd = instruction + references;
		const quoteEnd = referenceEnd + quotes;
		sections.push({ tag: assignment ? 'subagent-assignment' : 'user-request', text: content.slice(0, approvedPlan?.[0] ?? instruction) });
		if (references) sections.push({ tag: 'selected-material', text: content.slice(instruction, referenceEnd).trimStart() });
		if (quotes) sections.push({ tag: 'quoted-conversation', text: content.slice(referenceEnd, quoteEnd).trimStart() });
		if (quoteEnd < content.length) sections.push({ tag: 'goal-context', text: content.slice(quoteEnd).trimStart() });
		if (approvedPlan) sections.push({ tag: 'approved-plan', text: content.slice(approvedPlan[1], instruction) });
	}
	sections.push(...message.promptSections ?? []);
	const blocks = sections.filter(({ tag, text }) => typeof text === 'string' && tags.slice(1).includes(tag))
		.map(({ tag, text }) => `<${tag}>\n${xmlText(text)}\n</${tag}>`);
	return [taskPrompt && message.role === 'user' ? '' : neutralizePromptTags(content), ...blocks].filter(Boolean).join('\n\n');
}

export function promptMessage(...promptSections: PromptSection[]): Message {
	return { role: 'user', content: '', promptSections };
}
