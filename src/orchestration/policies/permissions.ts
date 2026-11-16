import type { PermissionPolicy } from '../../types';

/** 资源访问、工具行动与资料外发授权：默认只放开笔记库内的读写，外发需用户显式授权 */
export function createPermissionPolicy(): PermissionPolicy {
	return {
		canRead: () => true,
		canWrite: () => true,
		canCallTool: () => true,
		canSendOutbound: () => false,
	};
}
