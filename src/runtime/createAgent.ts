import { createRunState } from './runState';
import type { AgentLoop, RuntimeLayer } from '../types';

export function bindAgent(loop: AgentLoop): RuntimeLayer['createAgent'] {
	return (ctx, state) => ({ loop, state: state ?? createRunState(ctx) });
}
