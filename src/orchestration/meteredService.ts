import { reportedCost } from '../communication/reportedUsage';
import { modelUsageAttempts } from '../runtime/modelUsageAttempts';
import type { AuxiliaryUsage, ModelService } from '../types';

export type UsageRecord = (usage: AuxiliaryUsage, key: symbol) => Promise<void>;
export type UsagePreview = (key: symbol, usage: AuxiliaryUsage) => void;

export function meteredService(service: Pick<ModelService, 'send' | 'contextLimits'>, kind: AuxiliaryUsage['kind'],
	record: UsageRecord, preview?: UsagePreview): Pick<ModelService, 'send' | 'contextLimits'> {
	return {
		contextLimits: (model) => service.contextLimits?.(model),
		async send(request) {
			request.signal?.throwIfAborted();
			const key = Symbol();
			const attempts = modelUsageAttempts((receipt) => record({ kind, ...receipt }, key));
			// 停止任务时审核可能仍在返回，先记下已取得的用量或未知状态。
			const onAbort = () => { if (attempts.started) void attempts.save().catch(() => {}); };
			request.signal?.addEventListener('abort', onAbort, { once: true });
			let completed = false;
			try {
				const response = await service.send({ ...request, onTransmission: async (address) => {
					await request.onTransmission?.(address);
					request.signal?.throwIfAborted();
					await attempts.transmitted(address, request.signal);
				} }, (receipt) => {
					if (request.signal?.aborted) return;
					attempts.update(receipt);
					preview?.(key, { kind, ...receipt });
				});
				const receipt = attempts.receipt;
				const reportedUsage = response.reportedUsage ?? receipt.reportedUsage;
				const cost = reportedCost(response.usage) ?? reportedCost(response.raw.usage) ?? receipt.cost;
				const estimatedUsage = response.estimatedUsage;
				attempts.update({ ...(reportedUsage !== undefined && { reportedUsage }), ...(cost !== undefined && { cost }),
					...(estimatedUsage && { estimatedUsage }),
					...(response.usageStatus === 'provisional' && { usageStatus: 'provisional' }) });
				completed = true;
				return response;
			} finally {
				request.signal?.removeEventListener('abort', onAbort);
				if (completed || attempts.started) await attempts.save();
			}
		},
	};
}
