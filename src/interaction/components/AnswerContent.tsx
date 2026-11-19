import type { App } from 'obsidian';
import ChatMarkdown from './ChatMarkdown';

export default function AnswerContent({ app, content }: { app: App; content: string }) {
	return <ChatMarkdown app={app} content={content} />;
}
