import type { RunPolicy, ScribeSettings } from '../../types';

/** 任务运行策略：把配置中的运行限制整理成核心循环可直接读取的约束 */
export function createRunPolicy(settings: ScribeSettings): RunPolicy {
	return { ...settings.run };
}
