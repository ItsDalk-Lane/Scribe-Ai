export type SkillSource = { kind: 'builtin' | 'agent' | 'system' | 'local' | 'github'; origin?: string; displayPath?: string; version?: string };
export interface SkillPackageFile { path: string; data: Uint8Array }
export interface SkillImportRepairChange { before: string; after: string }
export interface SkillPackage { name: string; source: SkillSource; files: SkillPackageFile[]; repair?: SkillImportRepairChange[] }
export interface LibrarySkill {
	name: string; description: string; path: string; source: SkillSource; enabled: boolean; error?: string;
	displayName?: string; shortDescription?: string; defaultPrompt?: string; icon?: string; brandColor?: string;
	revision?: string; version?: string; author?: string; tags?: string[]; allowImplicit: boolean; userInvocable: boolean;
	usage: { count: number; lastUsedAt?: number; lastSource?: 'manual' | 'auto' }; dependencies: LibraryDependency[];
}
export interface LibraryDependency { type: 'command' | 'obsidian-plugin' | 'python-package' | 'mcp'; name: string; note?: string }
export interface ImportPreview { name: string; description: string; files: string[]; source: SkillSource; repairs: SkillImportRepairChange[]; status: 'new' | 'replace' | 'conflict'; token: string }
export interface SystemCandidate { id: string; name: string; description: string; path: string; sources: string[]; status: 'available' | 'installed' | 'conflict'; error?: string; renamedFrom?: string; repair?: SkillImportRepairChange[] }
export interface BuiltinStatus { name: string; status: 'installed' | 'removed' | 'missing' | 'modified' | 'conflict' }
export interface ManagedSkillLibrary {
	readonly directory: string;
	list(options?: { withRevisions?: boolean }): Promise<LibrarySkill[]>;
	revision(name: string): Promise<string>;
	listFiles(name: string): Promise<string[]>;
	readFile(name: string, path: string): Promise<string>;
	saveFile(name: string, path: string, text: string, expected: string): Promise<string>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	remove(name: string, expectedRevision?: string): Promise<void>;
	builtinStatus(): Promise<BuiltinStatus[]>;
	restore(name: string, expectedStatus?: BuiltinStatus['status'], expectedRevision?: string): Promise<void>;
	searchSystem(signal?: AbortSignal): Promise<{ candidates: SystemCandidate[]; warnings: string[] }>;
	previewLocal(path: string, kind?: 'system' | 'local', signal?: AbortSignal): Promise<ImportPreview>;
	previewGithub(url: string, signal?: AbortSignal): Promise<ImportPreview>;
	previewDraft(content: string): Promise<ImportPreview>;
	install(preview: ImportPreview, signal?: AbortSignal): Promise<void>;
	previewPackage(preview: ImportPreview): SkillPackage;
	discard(preview: ImportPreview): void;
	saveMetadata(name: string, patch: Pick<LibrarySkill, 'displayName'|'shortDescription'|'icon'|'brandColor'|'defaultPrompt'>, expected: LibrarySkill): Promise<void>;
	readIcon(name: string): Promise<string | undefined>;
	recordUse(name: string, kind?: 'manual' | 'auto'): Promise<void>;
	checkDependencies(name: string): Promise<{ name: string; ready: boolean; detail: string }[]>;
}
