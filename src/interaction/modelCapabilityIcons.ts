import { documentedRouteDetails, mergeModelCatalogDetails } from '../communication/modelCatalog';
import { catalogVideoInput } from '../communication/modelVideo';
import type { ModelCatalogDetails, ModelCatalogResult, ModelOverride, ModelProviderInfo, ProviderModelInfo } from '../types';

function normalizeAddress(address: string): string {
	const trimmed = address.trim();
	return (URL.parse(trimmed)?.href ?? trimmed).replace(/\/+$/, '');
}

export function modelCatalogAddress(provider: ModelProviderInfo, address: string, customProvider: boolean): string | undefined {
	const configured = normalizeAddress(address);
	return customProvider || (configured && configured !== normalizeAddress(provider.baseUrl)) ? address.trim() : undefined;
}

export function modelDetailsForConnection(provider: ModelProviderInfo, model: string, connection: {
	baseUrl: string;
	protocol: string;
	catalogAddress?: string;
	catalog?: ModelCatalogResult | null;
	overrides?: Record<string, ModelOverride>;
}) {
	const override = connection.overrides && Object.prototype.hasOwnProperty.call(connection.overrides, model) ? connection.overrides[model] : undefined;
	const bundled = connection.catalogAddress === undefined ? provider.models.find((entry) => entry.id === model) : undefined;
	const address = connection.baseUrl.trim() || bundled?.baseUrl || provider.baseUrl;
	const details = connection.catalog?.details?.get(model);
	const catalogProtocol = details?.connectionProtocol || bundled?.api;
	const protocol = connection.protocol || catalogProtocol || provider.protocol;
	const route = documentedRouteDetails(provider.id, model, override?.protocol || protocol, override?.baseUrl || address);
	// 单个模型换了地址或协议后，服务商目录无法确认这条连接的能力。
	if ((override?.baseUrl && normalizeAddress(override.baseUrl) !== normalizeAddress(address))
		|| (override?.protocol && override.protocol !== protocol)
		|| (catalogProtocol && protocol && catalogProtocol !== protocol)) return { override, details: route };
	return { override, bundled, details: route
		? mergeModelCatalogDetails(new Map([[model, route]]), details && new Map([[model, details]])).get(model) : details };
}

export function modelCapabilityIcons(details?: ModelCatalogDetails, bundled?: Pick<ProviderModelInfo, 'input' | 'reasoning'>) {
	const input = (details?.evidence?.inputModalities?.conflict ? undefined : details?.inputModalities) ?? bundled?.input ?? [];
	const icons = [
		['eye', input.includes('image')],
		['ear', input.includes('audio')],
		['video', catalogVideoInput(details) ?? input.includes('video')],
		['file-text', input.includes('pdf')],
		['lightbulb', (details?.reasoning ?? bundled?.reasoning) === true],
		['wrench', details?.tools === true],
		['braces', details?.structuredOutput === true && !details.evidence?.structuredOutput?.conflict],
	] as const;
	return icons.filter(([, supported]) => supported).map(([icon]) => icon);
}

export type ModelCapabilityIcon = ReturnType<typeof modelCapabilityIcons>[number];

export function renderModelCapabilityIcons(
	parent: HTMLElement,
	evidence: { details?: ModelCatalogDetails; bundled?: Pick<ProviderModelInfo, 'input' | 'reasoning'> },
	labels: Record<ModelCapabilityIcon, string>,
	setIcon: (element: HTMLElement, icon: ModelCapabilityIcon) => void,
): void {
	const icons = modelCapabilityIcons(evidence.details, evidence.bundled);
	if (!icons.length) return;
	const badges = parent.createDiv({ cls: 'scribe-model-panel-capabilities' });
	for (const icon of icons) {
		const label = labels[icon];
		const badge = badges.createSpan({ attr: { 'data-capability': icon, role: 'img', 'aria-label': label, title: label } });
		setIcon(badge, icon);
	}
}
