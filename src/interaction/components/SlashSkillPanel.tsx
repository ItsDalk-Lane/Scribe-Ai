import { useEffect, useState } from 'react';
import type { SkillScanIssue } from '../../skills/discovery';
import type { SkillInfo, SkillRegistry } from '../../types';
import { SkillMenuRow, skillMenuText } from './SkillTextArea';

export default function SlashSkillPanel({ registry, scope, onChoose }: {
	registry: SkillRegistry;
	scope: string[];
	onChoose: (item: SkillInfo) => void;
}) {
	const text = skillMenuText();
	const [items, setItems] = useState<SkillInfo[]>();
	const [issues, setIssues] = useState<SkillScanIssue[]>([]);
	const [error, setError] = useState('');
	const [search, setSearch] = useState('');
	const [changing, setChanging] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const scopeKey = JSON.stringify(scope);

	useEffect(() => {
		let version = 0;
		const load = () => {
			const current = ++version;
			setError('');
			setItems(undefined);
			setIssues([]);
			void registry.inspect([], '', JSON.parse(scopeKey) as string[]).then((report) => {
				if (version === current) {
					setItems(report.items);
					setIssues(report.issues);
				}
			}, (cause: unknown) => {
				if (version === current) setError(cause instanceof Error ? cause.message : text.fail);
			});
		};
		const unsubscribe = registry.subscribe(load);
		load();
		return () => {
			version++;
			unsubscribe();
		};
	}, [scopeKey, refresh, registry, text.fail]);

	async function toggle(item: SkillInfo) {
		setChanging(true);
		try {
			await registry.setEnabled(item.id, !item.enabled);
			setRefresh((value) => value + 1);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : text.fail);
		} finally {
			setChanging(false);
		}
	}

	const term = search.toLowerCase();
	const matches = items?.filter((item) =>
		[item.name, item.displayName, item.description, item.sourceLabel].some((part) => part?.toLowerCase().includes(term))) ?? [];

	return <>
		<input className="scribe-slash-panel-field" type="search" autoFocus aria-label={text.search} placeholder={text.search}
			value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
		{error && <p className="scribe-slash-panel-info" role="alert">{error} <button type="button"
			onClick={() => setRefresh((value) => value + 1)}>{text.retry}</button></p>}
		{!error && !items && <p className="scribe-slash-panel-info" role="status">{text.loading}</p>}
		{!error && items && !matches.length && <p className="scribe-slash-panel-info" role="status">{text.empty}</p>}
		{issues.length > 0 && <details className="scribe-skill-scan-notices">
			<summary>{text.issues} ({issues.length})</summary>
			<ul>{issues.map((issue) => <li key={issue.path}><strong>{issue.path}</strong><div>{issue.reason}</div></li>)}</ul>
		</details>}
		<div className="scribe-skill-command-list" role="group" aria-label={text.choose}>
			{matches.map((item) => <SkillMenuRow key={item.id} item={item} text={text} toggle choosing={changing}
				onChoose={onChoose} onToggle={(row) => void toggle(row)} />)}
		</div>
	</>;
}
