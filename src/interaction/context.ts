import { createContext } from 'react';
import type { ScribeServices } from '../types';

/** 交互界面共享状态：宿主注入的服务与当前任务指针 */
export interface InteractionState {
	services: ScribeServices;
	activeTaskId: string | null;
}

export const InteractionContext = createContext<InteractionState | null>(null);
