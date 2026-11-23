import type { App } from 'obsidian';
import { stripGoalReport } from '../chatGoal';
import { stripPlanMarkers } from '../chatPlan';
import ChatMarkdown from './ChatMarkdown';

export default function AnswerContent({ app, content }: { app: App; content: string }) {
	return <ChatMarkdown app={app} content={stripPlanMarkers(stripGoalReport(content))} />;
}
