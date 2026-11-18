import { useMemo } from 'react';
import { approvalDiff } from '../approvalDiff';
import { uiText } from '../uiText';

export default function FileChanges({ before, after, fragment = false }: { before?: string; after: string; fragment?: boolean }) {
	const text = uiText();
	const groups = useMemo(() => approvalDiff(before ?? '', after), [before, after]);
	return (
		<>
			{groups === null ? <p>{text.chatDiffFullPreview}</p> : groups.length === 0 ? <p>{fragment || after ? text.chatToolNoChanges : text.chatDiffEmpty}</p> : (
				<div className="scribe-approval-diff" role="region" aria-label={text.chatDiffChanges} tabIndex={0}>
					{groups.map((rows, group) => (
						<table key={group} className="scribe-approval-diff-group">
							<thead>
								<tr>
									<th scope="col">{text.chatDiffOldLine}</th>
									<th scope="col">{text.chatDiffNewLine}</th>
									<th scope="col" colSpan={2}>{text.chatDiffChanges}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row, index) => (
									<tr className={`scribe-approval-diff-row is-${row.kind}`} key={index}>
										<td>{row.oldLine}</td>
										<td>{row.newLine}</td>
										<td aria-label={row.kind === 'remove' ? text.chatDiffRemoved : row.kind === 'add' ? text.chatDiffAdded : undefined}>
											{row.kind === 'remove' ? '−' : row.kind === 'add' ? '+' : ''}
										</td>
										<td className="scribe-approval-diff-content">
											{row.text}
											{row.ending && <span className="scribe-approval-line-ending">
												{row.ending === 'none' ? text.chatDiffNoNewline : row.ending}
											</span>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					))}
				</div>
			)}
			<details className="scribe-approval-full-text" open={groups === null}>
				<summary>{text.chatDiffFullText}</summary>
				{before !== undefined && <div>
					<div>{text.chatBefore}</div>
					<pre className="scribe-chat-pre" tabIndex={0}>{before}</pre>
				</div>}
				<div>
					<div>{text.chatAfter}</div>
					<pre className="scribe-chat-pre" tabIndex={0}>{after}</pre>
				</div>
			</details>
		</>
	);
}
