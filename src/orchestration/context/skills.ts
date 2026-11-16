import { notImplemented } from '../../types';
import type { SkillInfo, SkillRegistry } from '../../types';

/** 技能资源与技能指令管理：技能本体归编排层，调用入口归工具层 */
export function createSkillRegistry(): SkillRegistry {
	const skills: SkillInfo[] = [];
	return {
		list: () => skills,
		load: () => notImplemented('技能加载'),
	};
}
