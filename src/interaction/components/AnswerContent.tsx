import type { App } from 'obsidian';
import { stripGoalReport } from '../chatGoal';
import { stripPlanMarkers } from '../chatPlan';
import ChatMarkdown from './ChatMarkdown';

export default function AnswerContent({ app, content, media = true }: { app: App; content: string; media?: boolean }) {
	return <ChatMarkdown app={app} media={media} content={stripPlanMarkers(stripGoalReport(content))} />;
}
