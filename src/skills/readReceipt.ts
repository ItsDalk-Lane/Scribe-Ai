import { createHash } from 'node:crypto';

export interface SkillReadReceipt {
	id: string;
	file: string;
	offset: number;
	digest: string;
	name?: string;
	fileDigest?: string;
}

export function skillReadDigest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function parseSkillReadReceipt(content: string): SkillReadReceipt | undefined {
	try {
		const data = JSON.parse(content.slice(content.lastIndexOf('\n') + 1)) as Partial<SkillReadReceipt> | null;
		if (typeof data?.id === 'string' && typeof data.file === 'string' && typeof data.offset === 'number'
			&& Number.isSafeInteger(data.offset) && data.offset >= 0 && typeof data.digest === 'string'
			&& (data.name === undefined || typeof data.name === 'string')
			&& (data.fileDigest === undefined || typeof data.fileDigest === 'string')) {
			return data as SkillReadReceipt;
		}
	} catch { /* 旧记录可能没有读取凭据。 */ }
	return;
}

export function skillReadName(content: string, receipt: SkillReadReceipt): string | undefined {
	return receipt.name || /^读取技能 (.+?)（.*） · /u.exec(content)?.[1];
}
