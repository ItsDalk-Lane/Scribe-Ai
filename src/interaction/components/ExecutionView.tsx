import { uiText } from '../uiText';

/** 执行展示：对话内容、任务状态、工具活动、最终结果与资料来源 */
export default function ExecutionView() {
	return <div className="scribe-panel scribe-execution-view">{uiText().noExecution}</div>;
}
