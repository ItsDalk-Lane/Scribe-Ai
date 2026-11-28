import { chineseMedia } from './mediaChinese';
import { directMedia } from './mediaDirect';
import { gatewayMedia } from './mediaGateways';
import { arkMedia } from './mediaArk';
import type { MediaOperation } from './mediaApi';

export const mediaAdapters = [...arkMedia, ...chineseMedia, ...directMedia, ...gatewayMedia];

export function mediaAdapter(providerId: string, model: string, operation: MediaOperation) {
	return mediaAdapters.find((adapter) => adapter.providerId === providerId && adapter.operation === operation && adapter.models.includes(model));
}

export function modelMediaAdapters(providerId: string, model: string) {
	return mediaAdapters.filter((adapter) => adapter.providerId === providerId && adapter.models.includes(model));
}

export function mediaModelKind(operation: MediaOperation) {
	return operation === 'image-edit' ? 'image' : operation === 'video-edit' ? 'video' : operation;
}
