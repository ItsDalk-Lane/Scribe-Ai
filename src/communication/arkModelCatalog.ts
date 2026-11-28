import type { ModelCatalogDetails, ModelCatalogModelType, ModelCatalogResult, Transport } from '../types';

const PUBLIC_DOCS = new Map([
	['volcengine-doubao', 'model-list'],
	['volcengine-agent-plan', 'agent-plan-personal-plan-overview'],
	['volcengine-coding-plan', 'coding-plan-personal-plan-overview'],
]);
const PAYG_SECTIONS: ReadonlyMap<string, ModelCatalogModelType> = new Map([
	['文本生成能力', 'text'], ['向量化能力', 'embedding'], ['图片生成能力', 'image'],
	['视频生成能力', 'video'], ['3D 生成能力', 'other'],
]);
const PLAN_TYPES: ReadonlyMap<string, ModelCatalogModelType> = new Map([
	['文本生成', 'text'], ['向量化', 'embedding'], ['图片生成', 'image'],
	['视频生成', 'video'], ['语音模型', 'audio'],
]);
// https://docs.volcengine.com/docs/ark/model-deprecation-notice
const RETIRED_PAYG_MODELS = new Set(['doubao-seed-2-0-pro-260215']);
// The plan announcements give the actual retirement dates even when the overview lags.
const RETIRED_PLAN_MODELS = new Set(['kimi-k3', 'minimax-m3']);
const RETIRED_STATUS = /已(?:经)?下线/u;
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*$/iu;

interface DocumentedModel {
	id: string;
	type: ModelCatalogModelType;
	specs: string[];
}

function tokenCount(match?: RegExpExecArray | null): number | undefined {
	if (!match?.[1]) return undefined;
	const unit = match[2]?.toLowerCase();
	const count = Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1);
	return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function parsePayg(markdown: string): DocumentedModel[] {
	const models: DocumentedModel[] = [];
	let section: ModelCatalogModelType | undefined;
	let current: DocumentedModel | undefined;
	for (const line of markdown.split('\n')) {
		const heading = /^#\s+(.+)$/u.exec(line)?.[1]?.trim();
		if (heading) {
			section = PAYG_SECTIONS.get(heading);
			current = undefined;
		}
		if (!section) continue;
		const [, first = ''] = line.split('|', 2);
		const model = /^\s*\[([\w.-]+)\]\([^)]*\/model\/detail\?[^)]*\)/u.exec(first)?.[1];
		if (line.startsWith('|') && model && MODEL_NAME.test(model) && !RETIRED_STATUS.test(first) && !RETIRED_PAYG_MODELS.has(model)) {
			current = { id: model, type: section, specs: [line] };
			models.push(current);
		} else if (line.startsWith('|') && !first.trim()) {
			current?.specs.push(line);
		} else if (line.trim()) {
			current = undefined;
		}
	}
	return models;
}

function importedPlanModel(id: string, type: ModelCatalogModelType): Pick<DocumentedModel, 'id' | 'type'> {
	// The visual and voice API references use these invocation names.
	if (id === 'doubao-seedream-5-0-pro') return { id: 'doubao-seedream-5.0-pro', type };
	if (id === 'doubao-seed-tts-2.0') return { id, type: 'speech-synthesis' };
	if (id === 'doubao-seed-asr-2.0') return { id, type: 'speech-recognition' };
	return { id, type };
}

function parsePlan(markdown: string, agentPlan: boolean): DocumentedModel[] {
	const models: DocumentedModel[] = [];
	let inModelTable = false;
	let current: DocumentedModel | undefined;
	for (const line of markdown.split('\n')) {
		if (!line.startsWith('|')) {
			inModelTable = false;
			current = undefined;
			continue;
		}
		const cells = line.split('|').map((value) => value.trim());
		if (cells[agentPlan ? 3 : 1] === '模型名称' && (!agentPlan || cells[2] === '领域')) {
			inModelTable = true;
			continue;
		}
		if (!inModelTable) continue;
		const label = cells[agentPlan ? 3 : 1] ?? '';
		if (!label) {
			current?.specs.push(line);
			continue;
		}
		current = undefined;
		const id = /^([a-z0-9][a-z0-9._-]*)(?:[ \t]|$)/iu.exec(label)?.[1];
		if (!id || RETIRED_STATUS.test(label) || RETIRED_PLAN_MODELS.has(id)) continue;
		const type = agentPlan ? PLAN_TYPES.get((cells[2] ?? '').split('（')[0] ?? '')
			: id === 'doubao-embedding-vision' ? 'embedding' : 'text';
		if (!type) continue;
		current = { ...importedPlanModel(id, type), specs: [line] };
		models.push(current);
	}
	return models;
}

export async function fetchArkPublicModelCatalog(
	providerId: string, fetch: Transport['fetch'], signal: AbortSignal,
): Promise<ModelCatalogResult | undefined> {
	const document = PUBLIC_DOCS.get(providerId);
	if (!document) return;
	const response = await fetch(new URL(`https://ark.volcengine.com/region:cn-beijing/docs/${document}.md`), {
		headers: { accept: 'text/markdown' }, redirect: 'error', signal,
	});
	if (!response.ok || !/^text\/(?:markdown|plain)(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
		await response.body?.cancel();
		throw new Error('Ark model catalog is unavailable');
	}
	const markdown = await response.text();
	signal.throwIfAborted();
	const documented = providerId === 'volcengine-doubao' ? parsePayg(markdown) : parsePlan(markdown, providerId === 'volcengine-agent-plan');
	const details = new Map<string, ModelCatalogDetails>();
	const models = new Set<string>();
	for (const { id, type, specs } of documented) {
		if (type === 'text') models.add(id);
		const description = specs.join('\n');
		const contextWindow = tokenCount(/上下文窗口\s*[:：]\s*(\d+)([km])?/iu.exec(description));
		const maxTokens = tokenCount(/最大(?:输出|回答)[^:：|\n]*[:：]\s*(\d+)([km])?/iu.exec(description));
		details.set(id, { type, ...(contextWindow && { contextWindow }), ...(maxTokens && { maxTokens }) });
	}
	if (!models.size) throw new Error('Invalid Ark model catalog');
	return { models: [...models], source: 'docs', details };
}
