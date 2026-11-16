import { uiText } from '../uiText';

/** 审阅与确认：展示待决事项，接收授权、修改审阅与任务控制 */
export default function ApprovalView() {
	return <div className="scribe-panel scribe-approval-view">{uiText().noApproval}</div>;
}
