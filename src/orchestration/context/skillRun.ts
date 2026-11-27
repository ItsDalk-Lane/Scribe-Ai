import { approvedPlanContent } from '../../interaction/chatPlan';
import { bindSkillMentions, isSkillMentionAt, SkillAccessChangedError, SkillSteeringError } from '../../skills/mentions';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isAbsolute, win32 } from 'node:path';
import { listSkillFiles, skillDirectory } from '../../skills/discovery';
import type { DiscoveredSkill } from '../../skills/discovery';
import { parseSkillReadReceipt, skillReadDigest as fingerprint } from '../../skills/readReceipt';
import type { Message, SkillMention, SkillSettings, TaskRequest } from '../../types';
import type { SkillRegistry } from './skills';
import { compilePathGlob } from '../../tools/support/pathGlob';
import { isSkillListing } from '../../tools/skillTools';

const installer = 'scribe:skill-installer';
const pageSize = 20_000;
const scanNotice = '技能扫描有异常，当前清单可能不完整。仍可使用已列出的技能。';
const sessionReference = /^s_[\w-]{12}$/u;

function modelSource({ sourceLabel }: DiscoveredSkill) {
	if (!isAbsolute(sourceLabel) && !win32.isAbsolute(sourceLabel)) return sourceLabel;
	return '共享目录 ' + (win32.basename(sourceLabel.split(' · ', 1)[0]!) || '根目录');
}

export function renderSkillCatalog(items: DiscoveredSkill[], settings: SkillSettings, window?: number, available = items) {
	const tokenLimit = Math.min(settings.catalogBudgetMaxTokens, window ? Math.max(1, Math.floor(window * settings.catalogBudgetPercent / 100)) : Infinity);
	const charLimit = window ? Infinity : 8_000;
	const names = new Map<string, number>();
	for (const { name, enabled } of available) if (enabled) names.set(name, (names.get(name) ?? 0) + 1);
	const rows = items.filter((s) => s.enabled && s.implicit).map((skill) => ({
		name: skill.name,
		selector: (names.get(skill.name) ?? 0) > 1 || sessionReference.test(skill.name) ? { name: skill.name, source: modelSource(skill) } : skill.name,
		description: Array.from(skill.description),
	}));
	const render = (row: typeof rows[number], length: number) => JSON.stringify([row.selector, row.description.slice(0, length).join('')]);
	const lineCost = (line: string) => ({
		tokens: Math.ceil((Buffer.byteLength(line) + 1) / 4),
		chars: window ? 0 : Array.from(line).length + 1,
	});
	function fits(length: number) {
		let tokens = 0, chars = 0;
		for (const row of rows) {
			const cost = lineCost(render(row, length));
			tokens += cost.tokens; chars += cost.chars;
			if (tokens > tokenLimit || chars > charLimit) return false;
		}
		return true;
	}
	// 先给每项留出名称和来源，再尽量均分说明长度。连名称也放不下时才省略整项。
	let low = 0, high = rows.reduce((max, row) => Math.max(max, Math.min(1024, row.description.length)), 0);
	if (fits(high)) low = high;
	else {
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(middle)) low = middle;
			else high = middle - 1;
		}
	}
	let tokens = 0, chars = 0;
	const kept: string[] = [], omitted: string[] = [];
	for (const row of rows) {
		const line = render(row, low), cost = lineCost(line);
		if (tokens + cost.tokens > tokenLimit || chars + cost.chars > charLimit) omitted.push(row.name);
		else { kept.push(line); tokens += cost.tokens; chars += cost.chars; }
	}
	return { listed: kept.length, list: kept.join('\n'), omitted, shortened: rows.some((row) => row.description.length > low) };
}

function listItems(items: DiscoveredSkill[], offset: number, reference: (skill: DiscoveredSkill) => string, incomplete: boolean) {
	return JSON.stringify({ total: items.length, ...(incomplete && { incomplete, notice: scanNotice }),
		items: items.slice(offset, offset + 50).map((skill) => ({ name: skill.name, source: modelSource(skill), description: skill.description, id: reference(skill) })) });
}

export function createSkillRun(registry: SkillRegistry, request: TaskRequest, window: number | undefined, signal: AbortSignal,
	taskId: string = randomUUID(), work?: (active: boolean) => void, sessionId = taskId) {
	const delivered = new Set<string>();
	const committed = new Map<string, SkillMention[]>();
	let bindings = new Map<string, SkillMention[]>();
	const primaryScope = request.skillScope ?? registry.scope(request.refs);
	const primaryNotePaths = request.skillNotePaths ?? registry.notePaths(request.refs);
	let scope = primaryScope;
	let notePaths = primaryNotePaths;
	let explicit = new Map<string, string>();
	const inheritedById = new Map(request.inheritedSkills?.map((skill) => [skill.id, skill.name]));
	const wasInherited = (id: string, name: string) => Boolean(request.subagentCallerTaskId && (request.inheritedSkills
		? inheritedById.get(id) === name : request.inheritedSkillIds?.includes(id)));
	let delegated = { inheritedSkills: [] as Pick<SkillMention, 'id' | 'name'>[], skillScope: primaryScope, skillNotePaths: primaryNotePaths };
	let creatorId: string | undefined;
	let pending = new Map<string, string>();
	const catalog = () => registry.inspect([], '', scope);
	const scopedReference = ({ id, name }: DiscoveredSkill, scope: string) => 's_' + createHash('sha256')
		.update(JSON.stringify([scope, id, name])).digest('base64url').slice(0, 12);
	const reference = (skill: DiscoveredSkill) => scopedReference(skill, sessionId);
	const matchers = new Map<string, ReturnType<typeof compilePathGlob>>();
	function canAutoUse(skill: DiscoveredSkill, paths = notePaths): boolean {
		return skill.implicit && (!skill.paths?.length || (paths.length > 0 && skill.paths.some((pattern) => {
			let matches = matchers.get(pattern);
			if (!matches) {
				matches = compilePathGlob(pattern.endsWith('/') ? pattern + '**' : pattern);
				matchers.set(pattern, matches);
			}
			return paths.some(matches);
		})));
	}
	const usable = (skill: DiscoveredSkill) => skill.enabled && (canAutoUse(skill) || (skill.manual && explicit.get(skill.id) === skill.name));
	function byReference(items: DiscoveredSkill[], id: string | undefined) {
		// 恢复旧任务仍认原来的完整标识。短标识碰撞时拒绝读取。
		const matches = id ? items.filter((skill) => skill.id === id || reference(skill) === id || scopedReference(skill, taskId) === id) : [];
		return matches.length === 1 ? matches[0] : undefined;
	}
	async function accessible(id: string, source?: string) {
		const { items } = await catalog();
		const exact = source === undefined ? byReference(items, id) : undefined;
		if (exact && usable(exact)) return exact;
		if (!exact && (source !== undefined || !sessionReference.test(id))) {
			const named = items.filter((skill) => skill.name === id && usable(skill) && (source === undefined || modelSource(skill) === source));
			if (named.length === 1) return named[0]!;
			if (named.length > 1) throw new Error(source === undefined ? '有多个同名技能，请使用清单中的来源，或改用 list_skills 返回的标识。'
				: '该来源仍有多个同名技能，请改用 list_skills 返回的标识。');
		}
		throw new Error('技能已停用、不在本轮范围内或需要用户点名。');
	}
	const files = async (s: DiscoveredSkill) => {
		if (s.managed) return (await registry.library.listFiles(s.managed)).join('\n');
		if (s.id === installer) return 'SKILL.md';
		return (await listSkillFiles(skillDirectory(s))).join('\n');
	};
	const rememberTransmission = () => {
		for (const [id, mentions] of bindings) committed.set(id, mentions);
	};
	return {
		rememberTransmission,
		rememberCommitted(messages: Message[]) {
			// 已保存插话也证明首条请求已送达，即使退出时还未保存紧随其后的模型回复。
			if (!committed.has('') && messages.some((m) => (m.role === 'assistant' && !m.local)
				|| (m.role === 'user' && m.id?.startsWith('steer:')))) {
				committed.set('', request.skillMentions ?? []);
			}
			for (const m of messages) if (m.role === 'user' && m.id?.startsWith('steer:') && !committed.has(m.id)) {
				committed.set(m.id, m.skillMentions ?? []);
			}
		},
		async project(messages: Message[], autoAllowed: boolean) {
			const inputs = [{ id: '', text: approvedPlanContent(request)?.instruction ?? request.instruction, mentions: request.skillMentions ?? [], scope: primaryScope, paths: primaryNotePaths },
				...messages.flatMap((m) => m.id?.startsWith('steer:') && m.role === 'user' && (m.skillInputLength !== undefined || m.skillScope || m.skillNotePaths)
					? [{ id: m.id, text: m.content.slice(0, m.skillInputLength ?? 0), mentions: m.skillMentions ?? [], scope: m.skillScope ?? [], paths: m.skillNotePaths ?? [] }] : [])];
			scope = [...new Set(inputs.flatMap((input) => input.scope))];
			notePaths = [...new Set(inputs.flatMap((input) => input.paths))];
			const { items, issues } = await catalog();
			const inherited = items.filter((skill) => skill.enabled && skill.manual && wasInherited(skill.id, skill.name));
			const chosen = new Map(inherited.map((skill) => [skill.id, skill]));
			// 用户已在上级选定同名来源，分派中的文字不重新选择或扩大这些授权。
			const inheritedNames = new Set([...inheritedById.values(), ...inherited.map((skill) => skill.name)]);
			const scopeKey = (folders: string[]) => JSON.stringify([...new Set(folders)].sort());
			const scoped = new Map([[scopeKey(scope), items]]);
			bindings = new Map();
			const requiredBy = new Map<string, string>();
			const selectedAt = new Map(inherited.map(({ id }) => [id, '']));
			for (const input of inputs) {
				if (!input.text.includes('$')) continue;
				const previous = committed.get(input.id);
				try {
					const key = scopeKey(input.scope);
					let local = scoped.get(key);
					if (!local) {
						local = await registry.list([], '', input.scope);
						scoped.set(key, local);
					}
					const selectable = inheritedNames.size ? local.filter((skill) => !inheritedNames.has(skill.name)) : local;
					const mentions = previous ?? bindSkillMentions(input.text,
						input.mentions.filter((mention) => !inheritedNames.has(mention.name)), selectable);
					bindings.set(input.id, mentions);
					for (const mention of mentions) {
						const skill = selectable.find((s) => s.id === mention.id && s.name === mention.name && s.manual && s.enabled);
						if (!skill || !isSkillMentionAt(input.text, mention)) continue;
						if (request.subagentCallerTaskId && !canAutoUse(skill, input.paths) && !wasInherited(skill.id, skill.name)) {
							if (previous) continue;
							throw new Error(`技能「${skill.name}」仅限用户点选，本次分派没有这项选择。`);
						}
						chosen.set(skill.id, skill);
						if (!selectedAt.has(skill.id)) selectedAt.set(skill.id, input.id);
						if (!previous && !requiredBy.has(skill.id)) requiredBy.set(skill.id, input.id);
					}
				} catch (error) {
					if (!input.id || signal.aborted) throw error;
					throw new SkillSteeringError(input.id, error instanceof Error ? error.message : '插话中选择的技能不可用。');
				}
			}
			creatorId = items.find((s) => registry.isCreator(s))?.id;
			const automatic = autoAllowed ? items.filter((skill) => skill.enabled && canAutoUse(skill)) : [];
			const notes = new Map<string, string>();
			const contents = new Map<string, { id: string; file: string; hash: string }>();
			const track = (id: string, file: string, value: string) => {
				contents.set(id + '\0' + file, { id, file, hash: fingerprint(value) });
			};
			pending = new Map();
			for (const s of chosen.values()) {
				signal.throwIfAborted();
				let content: string;
				try { content = await registry.read(s); } catch (error) {
					signal.throwIfAborted();
					const owner = requiredBy.get(s.id);
					if (owner === '') throw error;
					if (owner) throw new SkillSteeringError(owner, error instanceof Error ? error.message : '插话中选择的技能不可读。');
					chosen.delete(s.id);
					continue;
				}
				track(s.id, 'SKILL.md', content);
				const source = selectedAt.get(s.id) ?? '';
				const previous = notes.get(source);
				notes.set(source, [previous, `技能 ${s.name}（标识 ${reference(s)}）\n${content}`].filter(Boolean).join('\n\n'));
				if (s.managed) pending.set('manual:' + s.id, s.managed);
			}
			explicit = new Map([...chosen].map(([id, skill]) => [id, skill.name]));
			const outgoing: Message[] = [];
			const autoIds = new Set(automatic.map((skill) => skill.id));
			const authorized = items.filter((item) => chosen.has(item.id) || autoIds.has(item.id));
			const state = renderSkillCatalog(automatic, registry.options(), window, authorized);
			registry.reportBudget({ listed: state.listed, omitted: state.omitted, shortened: state.shortened });
			const listingCalls = new Map(messages.flatMap((m) => m.role === 'assistant' ? m.toolCalls ?? [] : [])
				.filter((call) => isSkillListing(call.name)).map((call) => [call.id, call]));
			const fileLists = new Map<string, string>();
			for (const m of messages) {
				if (m.role === 'tool' && !m.isError && isSkillListing(m.toolName)) {
					const call = m.toolCallId ? listingCalls.get(m.toolCallId) : undefined;
					const args = call?.input as { id?: string; offset?: number } | undefined;
					let content = '此技能目录已失效，请按当前权限重新查询。';
					if (autoAllowed && args && m.toolName === call?.name) {
						if (call.name === 'list_skills' && args.id === undefined) content = listItems(authorized, args.offset ?? 0, reference, issues.length > 0);
						else {
							const s = byReference(authorized, args.id);
							if (s) try { content = await files(s); fileLists.set(s.id, content); } catch { signal.throwIfAborted(); }
						}
					}
					outgoing.push({ ...m, content });
					continue;
				}
				const receipt = m.role === 'tool' && m.toolName === 'read_skill' && !m.isError ? parseSkillReadReceipt(m.content) : undefined;
				if (!receipt) {
					outgoing.push(m.role === 'tool' && m.toolName === 'read_skill' && !m.isError
						? { ...m, content: '请按当前权限重新读取这个技能文件。' } : m);
					continue;
				}
				let content: string;
				let deliveredInstruction = false;
				const s = authorized.find((skill) => skill.id === receipt.id);
				try {
					if (!s) throw new Error('技能已停用或授权已撤回。');
					const raw = await registry.read(s, receipt.file);
					if (fingerprint(raw) !== receipt.digest) throw new Error('文件内容已变化，请重新读取。');
					track(s.id, receipt.file, raw);
					deliveredInstruction = receipt.file === 'SKILL.md';
					const end = receipt.offset + pageSize;
					content = `${s.name}（标识 ${reference(s)}） · ${receipt.file}\n${raw.slice(receipt.offset, end)}`
						+ (end < raw.length ? `\n下一页 offset=${end}，digest=${receipt.digest}` : '');
					if (s.managed && receipt.offset === 0 && receipt.file === 'SKILL.md' && !explicit.has(s.id)) pending.set('auto:' + m.toolCallId, s.managed);
				} catch (error) { content = error instanceof Error ? error.message : '技能文件无法读取。'; }
				outgoing.push(deliveredInstruction ? { ...m, content: '', promptSections: [{ tag: 'skill-instructions', text: content }] } : { ...m, content });
			}
			const projectedScope = scope;
			const projectedPaths = notePaths;
			const beforeSend = authorized.length ? async () => {
				const grants = () => {
					const prefs = registry.options();
					return JSON.stringify([prefs.sharedDirectories, prefs.disabledIds]);
				};
				const initialGrants = grants();
				const fresh = new Map((await registry.list([], '', projectedScope)).map((s) => [s.id, s]));
				for (const old of authorized) {
					const now = fresh.get(old.id);
					if (!now?.enabled || now.name !== old.name || now.sourceLabel !== old.sourceLabel || now.description !== old.description
						|| (chosen.has(old.id) && !now.manual) || (autoIds.has(old.id) && !canAutoUse(now, projectedPaths))) {
						throw new SkillAccessChangedError('发送前技能权限或目录已变化。');
					}
				}
				try {
					for (const { id, file, hash } of contents.values()) {
						if (fingerprint(await registry.read(fresh.get(id)!, file)) !== hash) throw new Error();
					}
					for (const [id, names] of fileLists) {
						if (await files(fresh.get(id)!) !== names) throw new Error();
					}
				} catch {
					signal.throwIfAborted();
					throw new SkillAccessChangedError('发送前技能文件已变化。');
				}
				if (initialGrants !== grants()) throw new SkillAccessChangedError('核对期间技能权限已变化。');
			} : undefined;
			return { messages: outgoing, guidance: state.list, instructionsByMessage: notes, beforeSend };
		},
		delegation() {
			return { inheritedSkills: delegated.inheritedSkills.map((skill) => ({ ...skill })),
				skillScope: [...delegated.skillScope], skillNotePaths: [...delegated.skillNotePaths] };
		},
		async accept(messages: Message[]) {
			rememberTransmission();
			// 只有模型收到本轮消息后，才允许向下一级转交实际点选的来源。
			delegated = {inheritedSkills:[...explicit].filter(([id, name]) => !request.subagentCallerTaskId
				|| wasInherited(id, name))
				.map(([id, name]) => ({id, name})), skillScope: [...scope], skillNotePaths: [...notePaths]};
			for (const [key, name] of pending) {
				if (delivered.has(key) || (key.startsWith('auto:') && !messages.some((m) => m.toolCallId === key.slice(5)))) continue;
				delivered.add(key);
				await registry.library.recordUse(name, key.startsWith('auto:') ? 'auto' : 'manual').catch(() => {});
			}
		},
		canUse(name: string) {
			if (name === 'propose_skill') return !!creatorId && explicit.has(creatorId) && (!request.subagentCallerTaskId || wasInherited(creatorId, 'skill-creator'));
			if (name === 'install_skill' || name === 'list_curated_skills') return explicit.has(installer);
			return true;
		},
		async list(offset: number) {
			const { items, issues } = await catalog();
			return listItems(items.filter(usable), offset, reference, issues.length > 0);
		},
		async files(id: string) { return files(await accessible(id)); },
		async read(id: string, file: string, offset: number, digest?: string, sourceLabel?: string) {
			const skill = await accessible(id, sourceLabel);
			const { source, text } = await registry.readForCall(skill, file);
			const hash = fingerprint(text);
			if (offset > text.length || (offset > 0 && digest !== hash)) throw new Error('技能文件已变化或页码无效，请从头读取。');
			return `读取技能 ${skill.name}（${skill.sourceLabel}） · ${file}\n${JSON.stringify({
				id: skill.id, file, offset, digest: hash, name: skill.name, fileDigest: source === text ? hash : fingerprint(source),
			})}`;
		},
		async propose(content: string) {
			if (!creatorId || !explicit.has(creatorId) || !registry.isCreator(await accessible(creatorId))) throw new Error('请先选择内置创建技能。');
			return registry.propose(content, signal, work);
		},
		async install(source: string) {
			if (!explicit.has(installer)) throw new Error('请先选择聊天安装入口。');
			return registry.install(source, signal, work);
		},
	};
}

export type SkillRun = ReturnType<typeof createSkillRun>;
