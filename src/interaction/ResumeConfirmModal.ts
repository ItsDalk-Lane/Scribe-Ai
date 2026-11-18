import { ButtonComponent, Modal } from 'obsidian';
import type { App } from 'obsidian';
import type { Message, ResumePreview } from '../types';
import { uiText } from './uiText';

export function confirmResume(app: App, preview: ResumePreview, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	const text = uiText();
	const { address, request, source } = preview;
	const labels: Record<Message['role'], string> = {
		system: text.chatResumeRules, user: text.chatYou, assistant: text.chatAssistant, tool: text.chatStepResult,
	};
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.modalEl.addClass('scribe-resume-modal');
		let approved = false;
		const close = () => modal.close();
		modal.onClose = () => {
			signal.removeEventListener('abort', close);
			resolve(approved && !signal.aborted);
		};
		modal.titleEl.setText(text.chatResumeReview);
		const destination = modal.contentEl.createEl('p');
		destination.createEl('strong', { text: text.chatResumeAddress });
		destination.createDiv({ cls: 'scribe-chat-content', text: address });
		destination.createDiv({ text: request.model });
		modal.contentEl.createEl('p', { text: text.chatResumeDisclosure });

		if (source.refs.length) {
			const scope = modal.contentEl.createEl('details');
			scope.createEl('summary', { text: text.chatResumeScope });
			const paths = scope.createEl('ul');
			for (const ref of source.refs) paths.createEl('li', { text: ref.path });
		}
		modal.contentEl.createEl('h3', { text: text.chatResumeContents });
		const contents = modal.contentEl.createDiv({
			cls: 'scribe-resume-contents',
			attr: { role: 'region', 'aria-label': text.chatResumeContents, tabindex: '0' },
		});
		const messages: Message[] = request.system ? [{ role: 'system', content: request.system }, ...request.messages] : request.messages;
		for (const message of messages) {
			const data = [message.content, ...(message.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.input)}`)];
			contents.createEl('strong', { text: message.toolName ?? labels[message.role] });
			contents.createEl('pre', { cls: 'scribe-chat-pre', text: data.filter(Boolean).join('\n') });
		}
		const actions = modal.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
		new ButtonComponent(actions).setButtonText(text.cancel).onClick(close);
		new ButtonComponent(actions).setClass('mod-cta').setButtonText(text.chatResume).onClick(() => {
			approved = true;
			close();
		});
		signal.addEventListener('abort', close, { once: true });
		modal.open();
		if (signal.aborted) close();
	});
}
