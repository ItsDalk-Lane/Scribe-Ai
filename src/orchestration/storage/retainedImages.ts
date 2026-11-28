import type { ConversationStore, Message, NoteRef } from '../../types';
import { isCachedImagePath, isGeneratedMediaCachePath } from './paths';

const draftImages = new Set<{ store: Pick<ConversationStore, 'list'>; owner: string; refs: NoteRef[] }>();

export function retainDraftImages(store: Pick<ConversationStore, 'list'>, owner: string | null, refs: NoteRef[]): () => void {
	const draft = { store, owner: owner ?? '', refs: refs.filter((ref) => ref.pastedImage) };
	if (draft.refs.length) draftImages.add(draft);
	return () => { draftImages.delete(draft); };
}

export function draftImagePaths(store: Pick<ConversationStore, 'list'>, owner: string) {
	const paths = new Set<string>();
	for (const draft of draftImages) if (draft.store === store && draft.owner === owner) addRefs(paths, draft.refs);
	return paths;
}

function addRefs(found: Set<string>, refs?: NoteRef[]) {
	for (const ref of refs ?? []) if (ref.pastedImage && isCachedImagePath(ref.path)) found.add(ref.path);
}

function addMessages(found: Set<string>, messages: Message[], keepTool: boolean) {
	for (const { imageRefs, generatedMedia } of messages) {
		for (const ref of imageRefs ?? []) {
			if ((ref.kind === 'pasted' || (keepTool && ref.kind === 'tool')) && isCachedImagePath(ref.path)) found.add(ref.path);
		}
		for (const { path } of generatedMedia ?? []) if (isGeneratedMediaCachePath(path)) found.add(path);
	}
}

export async function savedImagePaths(store: Pick<ConversationStore, 'load' | 'loadGoal' | 'mediaVideoHistory'>, id: string): Promise<Set<string>> {
	const found = new Set<string>();
	const [saved, goal, videoJobs] = await Promise.all([store.load(id), store.loadGoal(id), store.mediaVideoHistory?.list(id)]);
	for (const { media, pendingMedia } of videoJobs ?? []) {
		const path = (media ?? pendingMedia)?.path;
		if (path && isGeneratedMediaCachePath(path)) found.add(path);
	}
	addRefs(found, goal?.refs);
	for (const { request } of saved.queue ?? []) addRefs(found, request.refs);
	for (const run of saved.runs) {
		addRefs(found, run.request.refs);
		addMessages(found, run.state.messages, !run.finalized);
	}
	for (const { record } of saved.subagents ?? []) {
		if (record.kind === 'create') addMessages(found, record.history ?? [], true);
		if (record.kind !== 'run') continue;
		const entry = record.entry;
		if (entry.type === 'start') addRefs(found, entry.task.request.refs);
		if (entry.type === 'messages') addMessages(found, entry.messages, true);
	}
	return found;
}

export async function retainedImagePaths(store: Pick<ConversationStore, 'list' | 'load' | 'loadGoal' | 'mediaVideoHistory'>, deleting?: string) {
	const found = new Set<string>();
	for (const { id } of await store.list()) {
		if (id.toLowerCase() === deleting?.toLowerCase()) continue;
		for (const path of await savedImagePaths(store, id)) found.add(path);
	}
	for (const draft of draftImages) if (draft.store === store && draft.owner.toLowerCase() !== deleting?.toLowerCase()) addRefs(found, draft.refs);
	return found;
}
