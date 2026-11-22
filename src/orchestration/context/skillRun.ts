import { bindSkillMentions, isSkillMentionAt, SkillAccessChangedError, SkillSteeringError } from '../../skills/mentions';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { listSkillFiles, skillDirectory } from '../../skills/discovery';
import type { DiscoveredSkill } from '../../skills/discovery';
import type { Message, SkillMention, SkillSettings, TaskRequest } from '../../types';
import type { SkillRegistry } from './skills';

const installer = 'scribe:skill-installer';
const pageSize = 20_000;

export function renderSkillCatalog(items: DiscoveredSkill[], settings: SkillSettings, window?: number) {
	const tokenLimit = Math.min(settings.catalogBudgetMaxTokens, window ? Math.max(1, Math.floor(window * settings.catalogBudgetPercent / 100)) : Infinity);
	const charLimit = window ? Infinity : 8_000;
	const rows = items.filter((s) => s.enabled && s.implicit).map((s) => ({ skill: s, description: Array.from(s.description) }));
	const render = (row: typeof rows[number], length: number) => JSON.stringify([row.skill.name, row.skill.id, row.description.slice(0, length).join('')]);
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
		if (tokens + cost.tokens > tokenLimit || chars + cost.chars > charLimit) omitted.push(row.skill.name);
		else { kept.push(line); tokens += cost.tokens; chars += cost.chars; }
	}
	return { listed: kept.length, list: kept.join('\n'), omitted, shortened: rows.some((row) => row.description.length > low) };
}

function listItems(items: DiscoveredSkill[], offset: number) {
	return JSON.stringify({ total: items.length, items: items.slice(offset, offset + 50).map(({ name, description, id }) => ({ name, description, id })) });
}

interface Receipt { id: string; file: string; offset: number; digest: string }
function parseReceipt(message: Message): Receipt | undefined {
	if (message.role !== 'tool' || message.toolName !== 'read_skill' || message.isError) return;
	try {
		const data = JSON.parse(message.content.split('\n').at(-1) ?? '') as Partial<Receipt>;
		if (typeof data.id === 'string' && typeof data.file === 'string' && Number.isSafeInteger(data.offset)
			&& data.offset! >= 0 && typeof data.digest === 'string') return data as Receipt;
	} catch { /* 中断或旧版本的结果不带读取凭据。 */ }
	return;
}
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

export function createSkillRun(registry: SkillRegistry, request: TaskRequest, window: number | undefined, signal: AbortSignal) {
	const delivered = new Set<string>();
	const committed = new Map<string, SkillMention[]>();
	let bindings = new Map<string, SkillMention[]>();
	const primaryScope = request.skillScope ?? registry.scope(request.refs);
	let scope = primaryScope;
	let explicit = new Map<string, string>();
	const inheritedById = new Map(request.inheritedSkills?.map((skill) => [skill.id, skill.name]));
	const wasInherited = (id: string, name: string) => Boolean(request.subagentCallerTaskId && (request.inheritedSkills
		? inheritedById.get(id) === name : request.inheritedSkillIds?.includes(id)));
	let delegated = {inheritedSkills: [] as Pick<SkillMention, 'id' | 'name'>[], skillScope: primaryScope};
	let creatorId: string | undefined;
	let pending = new Map<string, string>();
	const catalog = () => registry.list([], '', scope);
	async function accessible(id: string) {
		const items = await catalog();
		const named = items.filter((s) => s.id === id || s.name === id);
		const usable = named.filter((s) => s.enabled && (s.implicit || explicit.get(s.id) === s.name));
		const exact = usable.find((s) => s.id === id);
		if (exact) return exact;
		// 模型有时会拿清单里的名称当标识；名称在可用技能中唯一时也接受。
		if (!named.some((s) => s.id === id) && usable.length === 1) return usable[0]!;
		if (!named.some((s) => s.id === id) && usable.length > 1) throw new Error('有多个同名技能，请改用 list_skills 返回的技能标识。');
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
			const inputs = [{ id: '', text: request.instruction, mentions: request.skillMentions ?? [], scope: primaryScope },
				...messages.flatMap((m) => m.id?.startsWith('steer:') && m.role === 'user' && (m.skillInputLength !== undefined || m.skillScope)
					? [{ id: m.id, text: m.content.slice(0, m.skillInputLength ?? 0), mentions: m.skillMentions ?? [], scope: m.skillScope ?? [] }] : [])];
			scope = [...new Set(inputs.flatMap((input) => input.scope))];
			const items = await catalog();
			const inherited = items.filter((skill) => skill.enabled && skill.manual && wasInherited(skill.id, skill.name));
			const chosen = new Map(inherited.map((skill) => [skill.id, skill]));
			// 用户已在上级选定同名来源，分派中的文字不重新选择或扩大这些授权。
			const inheritedNames = new Set([...inheritedById.values(), ...inherited.map((skill) => skill.name)]);
			const scopeKey = (folders: string[]) => JSON.stringify([...new Set(folders)].sort());
			const scoped = new Map([[scopeKey(scope), items]]);
			bindings = new Map();
			const requiredBy = new Map<string, string>();
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
						if (request.subagentCallerTaskId && !skill.implicit && !wasInherited(skill.id, skill.name)) {
							if (previous) continue;
							throw new Error(`技能「${skill.name}」仅限用户点选，本次分派没有这项选择。`);
						}
						chosen.set(skill.id, skill);
						if (!previous && !requiredBy.has(skill.id)) requiredBy.set(skill.id, input.id);
					}
				} catch (error) {
					if (!input.id || signal.aborted) throw error;
					throw new SkillSteeringError(input.id, error instanceof Error ? error.message : '插话中选择的技能不可用。');
				}
			}
			creatorId = items.find((s) => registry.isCreator(s))?.id;
			const state = renderSkillCatalog(autoAllowed ? items : [], registry.options(), window);
			registry.reportBudget({ listed: state.listed, omitted: state.omitted, shortened: state.shortened });
			const notes: string[] = [];
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
				notes.push(`技能 ${s.name}（${s.sourceLabel}），位置 ${s.id}\n${content}`);
				if (s.managed) pending.set('manual:' + s.id, s.managed);
			}
			explicit = new Map([...chosen].map(([id, skill]) => [id, skill.name]));
			const outgoing: Message[] = [];
			const authorized = items.filter((item) => item.enabled && (chosen.has(item.id) || (autoAllowed && item.implicit)));
			const listingCalls = new Map(messages.flatMap((m) => m.role === 'assistant' ? m.toolCalls ?? [] : [])
				.filter((call) => call.name === 'list_skills' || call.name === 'list_skill_files').map((call) => [call.id, call]));
			const fileLists = new Map<string, string>();
			for (const m of messages) {
				if (m.role === 'tool' && !m.isError && (m.toolName === 'list_skills' || m.toolName === 'list_skill_files')) {
					const call = m.toolCallId ? listingCalls.get(m.toolCallId) : undefined;
					const args = call?.input as { id?: string; offset?: number } | undefined;
					let content = '此技能目录已失效，请按当前权限重新查询。';
					if (autoAllowed && args && m.toolName === call?.name) {
						if (call.name === 'list_skills') content = listItems(authorized, args.offset ?? 0);
						else {
							const s = authorized.find((skill) => skill.id === args.id);
							if (s) try { content = await files(s); fileLists.set(s.id, content); } catch { signal.throwIfAborted(); }
						}
					}
					outgoing.push({ ...m, content });
					continue;
				}
				const receipt = parseReceipt(m);
				if (!receipt) {
					outgoing.push(m.role === 'tool' && m.toolName === 'read_skill' && !m.isError
						? { ...m, content: '请按当前权限重新读取这个技能文件。' } : m);
					continue;
				}
				let content: string;
				const s = items.find((i) => i.id === receipt.id && i.enabled && (explicit.has(i.id) || (autoAllowed && i.implicit)));
				try {
					if (!s) throw new Error('技能已停用或授权已撤回。');
					const raw = await registry.read(s, receipt.file);
					if (fingerprint(raw) !== receipt.digest) throw new Error('文件内容已变化，请重新读取。');
					track(s.id, receipt.file, raw);
					const end = receipt.offset + pageSize;
					content = `${s.name}（${s.sourceLabel}） · ${receipt.file}\n${raw.slice(receipt.offset, end)}`
						+ (end < raw.length ? `\n下一页 offset=${end}，digest=${receipt.digest}` : '');
					if (s.managed && receipt.offset === 0 && receipt.file === 'SKILL.md' && !explicit.has(s.id)) pending.set('auto:' + m.toolCallId, s.managed);
				} catch (error) { content = error instanceof Error ? error.message : '技能文件无法读取。'; }
				outgoing.push({ ...m, content });
			}
			const help = autoAllowed ? ['可用技能清单，依次为名称、技能标识和用途。按任务需要使用 read_skill 读取完整说明；传给 read_skill 的是技能标识（第二项，不是名称）。配套材料使用同一技能的标识。清单只适用于本轮。', state.list,
				state.omitted.length ? '部分技能受清单容量限制，需要时可用 list_skills 查看。' : ''].filter(Boolean).join('\n') : '';
			const projectedScope = scope;
			const beforeSend = authorized.length ? async () => {
				const grants = () => {
					const prefs = registry.options();
					return JSON.stringify([prefs.sharedDirectories, prefs.disabledIds]);
				};
				const initialGrants = grants();
				const fresh = new Map((await registry.list([], '', projectedScope)).map((s) => [s.id, s]));
				for (const old of authorized) {
					const now = fresh.get(old.id);
					if (!now?.enabled || now.name !== old.name || now.description !== old.description
						|| (chosen.has(old.id) && !now.manual) || (autoAllowed && old.implicit && !now.implicit)) {
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
			return { messages: outgoing, guidance: help, instructions: notes.join('\n\n'), beforeSend };
		},
		delegation() { return {inheritedSkills: delegated.inheritedSkills.map((skill) => ({...skill})), skillScope: [...delegated.skillScope]}; },
		async accept(messages: Message[]) {
			rememberTransmission();
			// 只有模型收到本轮消息后，才允许向下一级转交实际点选的来源。
			delegated = {inheritedSkills:[...explicit].filter(([id, name]) => !request.subagentCallerTaskId
				|| wasInherited(id, name))
				.map(([id, name]) => ({id, name})), skillScope:[...scope]};
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
			return listItems((await catalog()).filter((s) => s.enabled && (s.implicit || explicit.get(s.id) === s.name)), offset);
		},
		async files(id: string) { return files(await accessible(id)); },
		async read(id: string, file: string, offset: number, digest?: string) {
			const skill = await accessible(id);
			const value = await registry.read(skill, file);
			const hash = fingerprint(value);
			if (offset > value.length || (offset > 0 && digest !== hash)) throw new Error('技能文件已变化或页码无效，请从头读取。');
			return `读取技能 ${skill.name}（${skill.sourceLabel}） · ${file}\n${JSON.stringify({ id: skill.id, file, offset, digest: hash })}`;
		},
		async propose(content: string) {
			if (!creatorId || !explicit.has(creatorId) || !registry.isCreator(await accessible(creatorId))) throw new Error('请先选择内置创建技能。');
			return registry.propose(content, signal);
		},
		async install(source: string) {
			if (!explicit.has(installer)) throw new Error('请先选择聊天安装入口。');
			return registry.install(source, signal);
		},
	};
}

export type SkillRun = ReturnType<typeof createSkillRun>;
