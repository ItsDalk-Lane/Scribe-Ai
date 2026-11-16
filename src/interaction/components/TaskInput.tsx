/** 任务入口：接收用户指令与补充信息，提交给编排层 */
export default function TaskInput() {
	return (
		<div className="scribe-panel scribe-task-input">
			<textarea className="scribe-input" placeholder="描述要完成的任务" rows={3} />
			<button className="scribe-button" type="button">
				提交
			</button>
		</div>
	);
}
