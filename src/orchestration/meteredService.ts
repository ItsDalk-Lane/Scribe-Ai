import { reportedCost } from '../communication/reportedUsage';
import type { AuxiliaryUsage, ModelService, ModelUsageReceipt } from '../types';

export function meteredService(service: Pick<ModelService, 'send' | 'contextLimits'>, kind: AuxiliaryUsage['kind'],
	record: (usage: AuxiliaryUsage) => Promise<void>): Pick<ModelService, 'send' | 'contextLimits'> {
	return {
		contextLimits: (model) => service.contextLimits?.(model),
		async send(request) {
			request.signal?.throwIfAborted();
			let receipt: ModelUsageReceipt = {};
			let saved: Promise<void> | undefined;
			const save = () => saved ??= record({ kind, ...receipt });
			// 停止任务时审核可能仍在返回，先记下已取得的用量或未知状态。
			const onAbort = () => { void save().catch(() => {}); };
			request.signal?.addEventListener('abort', onAbort, { once: true });
			try {
				const response = await service.send(request, (usage) => { receipt = usage; });
				const reportedUsage = response.reportedUsage ?? receipt.reportedUsage;
				const cost = reportedCost(response.usage) ?? reportedCost(response.raw.usage) ?? receipt.cost;
				receipt = { ...(reportedUsage !== undefined && { reportedUsage }), ...(cost !== undefined && { cost }) };
				return response;
			} finally {
				request.signal?.removeEventListener('abort', onAbort);
				await save();
			}
		},
	};
}
