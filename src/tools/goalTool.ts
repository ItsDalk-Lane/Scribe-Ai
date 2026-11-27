import { MAX_GOAL_CRITERIA, parseNumberedGoalReport, reportGoalToolName } from '../interaction/chatGoal';
import type { ToolModule } from '../types';
import { fileToolInput } from './support/fileAccess';

export const goalTools: ToolModule = () => [{
	name: reportGoalToolName,
	description: '结束自动目标轮次前提交一次已核对的进展。报告不会直接完成目标，运行时会复核证据。提交成功后直接用普通正文向用户说明结果。',
	isReadOnly: true,
	inputSchema: {
		type: 'object', additionalProperties: false, required: ['checks', 'remaining'],
		properties: {
			checks: { type: 'array', maxItems: MAX_GOAL_CRITERIA, description: '只列本轮有实际证据的验收项。', items: {
				type: 'object', additionalProperties: false, required: ['criterion', 'evidence'],
				properties: {
					criterion: { type: 'integer', minimum: 1, maximum: MAX_GOAL_CRITERIA, description: '当前轮次给出的验收条件编号。' },
					evidence: { type: 'string', maxLength: 600, description: '可核对的具体依据。' },
					notePaths: { type: 'array', maxItems: 100, items: { type: 'string' }, description: '实际核对过的库内 Markdown 路径，含 .md 扩展名。' },
				},
			} },
			remaining: { type: 'array', maxItems: MAX_GOAL_CRITERIA, items: { type: 'string', maxLength: 600 }, description: '实际未完成项。全部条件已核对时才传空数组。' },
			blocked: { type: 'string', maxLength: 600, description: '无法继续时填写具体阻塞和所需信息。能够继续时省略。' },
		},
	},
	prepare(input, { task, goalReport }) {
		if (!task.request.goalRound || !goalReport) throw new Error('只有正在执行的聊天目标可以报告进展。');
		if (goalReport.recorded()) throw new Error('本轮进展已登记，请直接向用户汇报。');
		const report = fileToolInput(input, ['checks', 'remaining', 'blocked']);
		if (!parseNumberedGoalReport(report, goalReport.criterionCount)) throw new Error('目标报告参数无效。请核对本轮编号、依据、笔记路径和未完成事项。');
		return { run: () => '已登记本轮目标报告。请直接用普通正文向用户说明进展。' };
	},
}];
