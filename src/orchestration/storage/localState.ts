import { createHash, randomUUID } from 'node:crypto';
import type { App } from 'obsidian';
import { restoreChatGoal } from '../../interaction/chatGoal';
import { restoredTimelineExpansion } from '../../interaction/chatTimeline';
import type { ConversationStore, ExecutionMode } from '../../types';
import { readStoredJson, writeStoredJson } from './jsonFile';

type LocalStorage = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'> & {
	secretStorage: Pick<App['secretStorage'], 'getSecret' | 'setSecret'>;
};
type Goals = Pick<ConversationStore, 'loadGoal' | 'saveGoal'>;

const expansionKey = 'scribe-ai:timeline-expanded';
const oauthDeviceIdKey = 'oauth-device-id';
const localProfileKey = 'scribe-ai-local-profile';
const memoryScopePattern = /^[a-f0-9]{64}$/u;
const goalKey = (id: string) => `scribe-ai:chat-goal:${id}`;
export const executionModeKey = (id?: string) => id ? `scribe-ai:execution-mode:${id}` : 'scribe-ai:last-execution-mode';
const globalLegacyKeys = [executionModeKey(), expansionKey, oauthDeviceIdKey];

interface StoredState {
	device: string;
	contextScope?: string;
	legacyMemoryScope?: string;
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

export async function initializeLocalState(path: string, app: LocalStorage, conversationIds: readonly string[]) {
	const ids = [...new Set(conversationIds)];
	// Obsidian keeps this random profile secret with the local vault registration.
	let device = deviceId(app.secretStorage.getSecret(localProfileKey));
	if (!device) {
		device = randomUUID();
		app.secretStorage.setSecret(localProfileKey, device);
	}
	const contextScope = createHash('sha256').update(JSON.stringify([device, path])).digest('hex');
	const saved = record(await readStoredJson(path));
	const sameContext = saved.device === device && saved.contextScope === contextScope;
	const legacyScope = sameContext ? saved.legacyMemoryScope
		: typeof saved.device === 'string' && memoryScopePattern.test(saved.device) ? saved.contextScope : undefined;
	const legacyMemoryScope = typeof legacyScope === 'string' && memoryScopePattern.test(legacyScope)
		&& legacyScope !== contextScope ? legacyScope : undefined;
	const oldMode = (id?: string) => executionMode(legacyValue(app, executionModeKey(id)));
	const storedModes = record(saved.conversationModes);
	let state: StoredState = {
		device,
		contextScope,
		...(legacyMemoryScope && { legacyMemoryScope }),
		...(sameContext && saved.trustDirectoryRules === true && { trustDirectoryRules: true as const }),
		...(sameContext && saved.longTermMemory === true && { longTermMemory: true as const }),
		...(sameContext && saved.searchVaultHistory === true && { searchVaultHistory: true as const }),
		lastExecutionMode: (sameContext ? executionMode(saved.lastExecutionMode) : oldMode()) ?? 'ask',
		conversationModes: Object.fromEntries((sameContext ? Object.keys(storedModes) : ids).flatMap((id) => {
			const mode = sameContext ? executionMode(storedModes[id]) : oldMode(id);
			return mode ? [[id, mode]] : [];
		})),
		timelineExpanded: [...restoredTimelineExpansion(sameContext ? saved.timelineExpanded : legacyValue(app, expansionKey))],
		oauthDeviceId: deviceId(sameContext ? saved.oauthDeviceId : legacyValue(app, oauthDeviceIdKey)),
	};
	if (!sameContext) await writeStoredJson(path, state);

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
		legacyMemoryScope: () => state.legacyMemoryScope,
		clearLegacyMemoryScope: () => save((current) => current.legacyMemoryScope
			? { ...current, legacyMemoryScope: undefined } : current),
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
