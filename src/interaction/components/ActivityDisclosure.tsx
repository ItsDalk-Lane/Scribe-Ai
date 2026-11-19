import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import ChatIcon from './ChatIcon';

export default function ActivityDisclosure({
	icon, label, labelContent, title, accessibilityLabel, end, expanded, onToggle, children, className, state,
	plain = false, keepMounted = false,
}: {
	icon?: string;
	label: string;
	labelContent?: ReactNode;
	title?: string;
	accessibilityLabel?: string;
	end?: ReactNode;
	expanded: boolean;
	onToggle: () => void;
	children: ReactNode;
	className: string;
	state?: string;
	plain?: boolean;
	keepMounted?: boolean;
}) {
	const bodyId = useId();
	const open = plain || expanded;
	const [opened, setOpened] = useState(open);
	// 首次展开才渲染详情，之后保留内容以支持收起动画。
	if (open && !opened) setOpened(true);
	return (
		<div className={`scribe-activity-disclosure ${className}`} data-state={state} data-plain={plain || undefined}>
			{!plain && <div className="scribe-activity-heading">
				<button type="button" className="scribe-activity-toggle" aria-expanded={open} aria-controls={bodyId}
					aria-label={accessibilityLabel ?? label} title={title ?? label} onClick={onToggle} />
				{icon && <ChatIcon name={icon} />}
				<span className="scribe-activity-label" aria-hidden="true">
					{labelContent ?? label}
				</span>
				{end}
				<span className="scribe-activity-chevron"><ChatIcon name="chevron-right" /></span>
			</div>}
			<div id={bodyId} className="scribe-activity-expansion" aria-hidden={!open} inert={!open}>
				<div className="scribe-activity-body">{(opened || keepMounted) && children}</div>
			</div>
		</div>
	);
}
