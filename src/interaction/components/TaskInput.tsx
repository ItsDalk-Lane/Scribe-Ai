import { uiText } from '../uiText';

/** 任务入口：接收用户指令与补充信息，提交给编排层 */
export default function TaskInput() {
	const text = uiText();
	return (
		<div className="scribe-panel scribe-task-input">
			<textarea className="scribe-input" placeholder={text.taskPlaceholder} rows={3} />
			<button className="scribe-button" type="button">
				{text.submit}
			</button>
		</div>
	);
}
