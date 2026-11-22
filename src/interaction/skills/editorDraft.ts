import type { ManagedSkillLibrary } from '../../skills/library/contracts';

export interface SkillFileDraft { file: string; original: string; text: string }
const pending = new WeakMap<ManagedSkillLibrary, Map<string, SkillEditorSession>>();

// 页面关闭时仍保留有冲突的编辑；已保存的数据不留在内存缓存中。
export class SkillEditorSession {
	doc?: SkillFileDraft;
	private writes = Promise.resolve();
	constructor(readonly library: ManagedSkillLibrary, public name: string) {}
	static open(library: ManagedSkillLibrary, name: string) {
		return pending.get(library)?.get(name) ?? new SkillEditorSession(library, name);
	}
	static discard(library: ManagedSkillLibrary, name: string) { pending.get(library)?.delete(name); }
	get dirty() { return this.doc !== undefined && this.doc.text !== this.doc.original; }
	edit(text: string) {
		if (!this.doc) return;
		this.doc.text = text;
		if (!pending.has(this.library)) pending.set(this.library, new Map());
		if (this.dirty) pending.get(this.library)?.set(this.name, this);
	}
	flush(): Promise<void> {
		const run = this.writes.catch(() => undefined).then(async () => {
			const doc = this.doc;
			while (doc && doc.text !== doc.original) {
				const saved = doc.text;
				const oldName = this.name;
				this.name = await this.library.saveFile(oldName, doc.file, saved, doc.original);
				if (oldName !== this.name) {
					pending.get(this.library)?.delete(oldName);
					pending.get(this.library)?.set(this.name, this);
				}
				doc.original = saved;
			}
			if (!this.dirty) SkillEditorSession.discard(this.library, this.name);
		});
		this.writes = run;
		return run;
	}
}
