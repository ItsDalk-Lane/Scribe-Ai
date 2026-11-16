import { uiText } from '../uiText';

/** 资料范围选择：管理用户为任务指定的笔记、选区与资料范围 */
export default function ContextPicker() {
	return <div className="scribe-panel scribe-context-picker">{uiText().contextUnselected}</div>;
}
