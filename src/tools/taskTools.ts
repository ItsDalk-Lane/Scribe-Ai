import type { ToolDefinition } from '../types';
import type { ShellJobs, ShellJobView } from './external/shellJobs';
import { fileToolInput, requiredText } from './support/fileAccess';

const jobId = { type: 'string', description: '原聊天中后台命令返回的任务编号。' };
const unavailable = '在当前聊天找不到此后台任务。';
const statusLabels: Record<ShellJobView['status'], string> = {
	running: '正在运行', stopping: '正在停止', success: '成功', failed: '失败',
	'timed-out': '超时', stopped: '已停止', 'start-failed': '启动失败',
};

function jobStatus(job: ShellJobView): string {
	return `后台任务编号：${job.id}。状态：${statusLabels[job.status]}。`;
}

export function taskTools(jobs: ShellJobs): ToolDefinition[] {
	return [{
		name: 'ShellJobOutput',
		description: '按编号查看本聊天的后台命令状态、新增输出或已保存的首尾结果。子 Agent 只能查看自己发起的命令。结束后可用 final 查看完整保留结果。避免连续轮询。',
		isReadOnly: true,
		// The ring may hold 256 KiB; the shared 12,500-token model budget does the final bound.
		maxResultSizeChars: 300_000,
		inputSchema: {
			type: 'object',
			properties: { job_id: jobId, final: { type: 'boolean', description: '为 true 时取任务结束后的完整保留结果。' } },
			required: ['job_id'],
			additionalProperties: false,
		},
		prepare(input, ctx) {
			const args = fileToolInput(input, ['job_id', 'final']);
			const id = requiredText(args, 'job_id').trim();
			if (args.final !== undefined && typeof args.final !== 'boolean') throw new Error('final 必须是布尔值。');
			const owner = ctx.task.request.conversationId;
			const { subagentId } = ctx;
			return {
				async run() {
					const job = jobs.get(owner, id, subagentId);
					if (!job) {
						const saved = await jobs.getSaved(owner, id, subagentId);
						if (!saved) throw new Error(unavailable);
						return `${jobStatus(saved)}\n${saved.content}`;
					}
					const paths = jobs.outputPaths(owner, id, subagentId);
					const complete = paths.length ? `\n完整输出：${paths.join('；')}` : '';
					if (args.final === true) return `${jobStatus(job)}\n${job.content ?? '任务结束后可查看最终结果。'}${complete}`;
					const output = jobs.read(owner, id, 'model', subagentId);
					if (!output) throw new Error(unavailable);
					const added = [output.stdout, output.stderr && `错误输出\n${output.stderr}`].filter(Boolean).join('\n');
					return `${jobStatus(job)}\n${added || '暂无新增输出。'}${complete}`;
				},
			};
		},
	}, {
		name: 'ShellJobStop',
		description: '按编号停止本聊天发起的后台命令，并返回最终状态。子 Agent 只能停止自己发起的命令。已结束的任务只返回原有状态。',
		isReadOnly: false,
		inputSchema: { type: 'object', properties: { job_id: jobId }, required: ['job_id'], additionalProperties: false },
		prepare(input, ctx) {
			const args = fileToolInput(input, ['job_id']);
			const id = requiredText(args, 'job_id').trim();
			return {
				independent: true,
				async run() {
					const owner = ctx.task.request.conversationId;
					const job = await jobs.stop(owner, id, ctx.subagentId) ?? await jobs.getSaved(owner, id, ctx.subagentId);
					if (!job) throw new Error(unavailable);
					return jobStatus(job);
				},
			};
		},
	}];
}
