import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import type { App } from 'obsidian';
import { restoreChatGoal } from '../../interaction/chatGoal';
import { restoredTimelineExpansion } from '../../interaction/chatTimeline';
import type { ConversationStore, ExecutionMode } from '../../types';
import { readStoredJson, writeStoredJson } from './jsonFile';

type LegacyStorage = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;
type Goals = Pick<ConversationStore, 'loadGoal' | 'saveGoal'>;

const expansionKey = 'scribe-ai:timeline-expanded';
const oauthDeviceIdKey = 'oauth-device-id';
const goalKey = (id: string) => `scribe-ai:chat-goal:${id}`;
export const executionModeKey = (id?: string) => id ? `scribe-ai:execution-mode:${id}` : 'scribe-ai:last-execution-mode';
const globalLegacyKeys = [executionModeKey(), expansionKey, oauthDeviceIdKey];

interface StoredState {
	device: string;
	contextScope?: string;
	trustDirectoryRules?: true;
	longTermMemory?: true;
	searchVaultHistory?: true;
	lastExecutionMode: ExecutionMode;
	conversationModes: Record<string, ExecutionMode>;
	timelineExpanded: string[];
	oauthDeviceId?: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executionMode(value: unknown): ExecutionMode | undefined {
	return value === 'ask' || value === 'auto-review' || value === 'full-access' ? value : undefined;
}

function deviceId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function legacyValue(app: Pick<App, 'loadLocalStorage'>, key: string): unknown {
	try { return app.loadLocalStorage(key); } catch { return undefined; }
}

export async function initializeLocalState(path: string, app: LegacyStorage, conversationIds: readonly string[]) {
	const ids = [...new Set(conversationIds)];
	// 搬到另一台设备的笔记库不能自动继承本机的工具权限和登录标识。
	const device = createHash('sha256').update(JSON.stringify([process.platform, hostname(), homedir()])).digest('hex');
	const contextScope = createHash('sha256').update(JSON.stringify([device, path])).digest('hex');
	const saved = record(await readStoredJson(path));
	const currentDevice = saved.device === device;
	const sameContext = currentDevice && saved.contextScope === contextScope;
	const oldMode = (id?: string) => executionMode(legacyValue(app, executionModeKey(id)));
	const storedModes = record(saved.conversationModes);
	let state: StoredState = {
		device,
		contextScope,
		...(sameContext && saved.trustDirectoryRules === true && { trustDirectoryRules: true as const }),
		...(sameContext && saved.longTermMemory === true && { longTermMemory: true as const }),
		...(sameContext && saved.searchVaultHistory === true && { searchVaultHistory: true as const }),
		lastExecutionMode: (currentDevice ? executionMode(saved.lastExecutionMode) : oldMode()) ?? 'ask',
		conversationModes: Object.fromEntries((currentDevice ? Object.keys(storedModes) : ids).flatMap((id) => {
			const mode = currentDevice ? executionMode(storedModes[id]) : oldMode(id);
			return mode ? [[id, mode]] : [];
		})),
		timelineExpanded: [...restoredTimelineExpansion(currentDevice ? saved.timelineExpanded : legacyValue(app, expansionKey))],
		oauthDeviceId: deviceId(currentDevice ? saved.oauthDeviceId : legacyValue(app, oauthDeviceIdKey)),
	};
	if (!currentDevice) await writeStoredJson(path, state);

	let persisted = state;
	let writes = Promise.resolve();
	const pending = new Set<(current: StoredState) => StoredState>();
	let deviceIdSave: Promise<string> | undefined;
	let contextVersion = 0;
	function save(update: (current: StoredState) => StoredState): Promise<void> {
		pending.add(update);
		state = update(state);
		const result = writes.then(async () => {
			pending.delete(update);
			try {
				// 从最近成功保存的版本应用本次修改，避免带上另一项保存失败的设置。
				const next = update(persisted);
				if (next !== persisted) {
					await writeStoredJson(path, next);
					persisted = next;
				}
				if (!pending.size) state = persisted;
			} catch (error) {
				state = [...pending].reduce((current, next) => next(current), persisted);
				throw error;
			}
		});
		writes = result.catch(() => {});
		return result;
	}
	function clear(key: string): void {
		if (legacyValue(app, key) != null) app.saveLocalStorage(key, null);
	}
	function legacyGoal(id: string) {
		return restoreChatGoal(legacyValue(app, goalKey(id)));
	}
	async function restoreGoal(store: Goals, id: string) {
		const recorded = await store.loadGoal(id);
		const legacy = recorded === undefined ? legacyGoal(id) : undefined;
		if (legacy) await store.saveGoal(id, legacy);
		return { goal: legacy ?? restoreChatGoal(recorded), migrated: Boolean(legacy) };
	}
	const contextSetting = (key: 'trustDirectoryRules' | 'longTermMemory' | 'searchVaultHistory') =>
		state[key] === true && persisted[key] === true;
	const saveContextSetting = (key: 'trustDirectoryRules' | 'longTermMemory' | 'searchVaultHistory', enabled: boolean) => {
		contextVersion++;
		return save((current) => ({ ...current, [key]: enabled ? true : undefined })).finally(() => { contextVersion++; });
	};
	return {
		memoryScope: contextScope,
		contextVersion: () => contextVersion,
		directoryRulesTrusted: () => contextSetting('trustDirectoryRules'),
		saveDirectoryRulesTrust: (enabled: boolean) => saveContextSetting('trustDirectoryRules', enabled),
		memoryEnabled: () => contextSetting('longTermMemory'),
		saveMemoryEnabled: (enabled: boolean) => saveContextSetting('longTermMemory', enabled),
		vaultHistoryEnabled: () => contextSetting('searchVaultHistory'),
		saveVaultHistoryEnabled: (enabled: boolean) => saveContextSetting('searchVaultHistory', enabled),
		loadExecutionMode(id?: string): ExecutionMode {
			return id ? executionMode(state.conversationModes[id]) ?? 'ask' : state.lastExecutionMode;
		},
		saveExecutionMode(mode: ExecutionMode, id?: string): Promise<void> {
			return save((current) => {
				if (current.lastExecutionMode === mode && (!id || current.conversationModes[id] === mode)) return current;
				const conversationModes = id ? { ...current.conversationModes, [id]: mode } : current.conversationModes;
				return { ...current, lastExecutionMode: mode, conversationModes };
			});
		},
		async forgetConversation(id: string): Promise<void> {
			await save((current) => {
				const conversationModes = { ...current.conversationModes };
				delete conversationModes[id];
				return { ...current, conversationModes };
			});
			clear(executionModeKey(id));
			clear(goalKey(id));
		},
		timelineExpanded: () => restoredTimelineExpansion(state.timelineExpanded),
		saveTimelineExpanded(expanded: ReadonlySet<string>) {
			const timelineExpanded = [...expanded];
			return save((current) => ({ ...current, timelineExpanded }));
		},
		getOAuthDeviceId(): Promise<string> {
			if (persisted.oauthDeviceId) return Promise.resolve(persisted.oauthDeviceId);
			if (deviceIdSave) return deviceIdSave;
			const id = randomUUID();
			deviceIdSave = save((current) => ({ ...current, oauthDeviceId: id })).then(() => id).finally(() => { deviceIdSave = undefined; });
			return deviceIdSave;
		},
		restoreGoal,
		hasLegacy(): boolean {
			return globalLegacyKeys.some((key) => legacyValue(app, key) != null)
				|| ids.some((id) => legacyValue(app, executionModeKey(id)) != null || Boolean(legacyGoal(id)));
		},
		async migrateLegacyGoals(store: Goals): Promise<void> {
			for (const id of ids) if (legacyGoal(id)) await restoreGoal(store, id);
		},
		async clearLegacy(store: Goals): Promise<void> {
			await writes;
			if (JSON.stringify(await readStoredJson(path)) !== JSON.stringify(persisted)) throw new Error('无法确认插件状态已经迁移。');
			for (const key of globalLegacyKeys) clear(key);
			for (const id of ids) {
				clear(executionModeKey(id));
				if (legacyGoal(id) && (await store.loadGoal(id)) !== undefined) clear(goalKey(id));
			}
		},
	};
}

export type LocalState = Awaited<ReturnType<typeof initializeLocalState>>;
