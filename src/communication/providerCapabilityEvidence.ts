import type { ModelCatalogDetails } from '../types';

const azureSchema = [
	'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini',
	'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.4',
];
const vertexGemini = [
	'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite',
	'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash',
	'gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-robotics-er-2-preview',
];
const tokenPlanIds = [
	'bailian-token-plan', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan-individual-cn',
];
const bedrockClaudeSchema = {
	'fable-5-2': ['', 'us', 'global'],
	'haiku-4-5-20251001-v1:0': ['', 'us', 'eu', 'au', 'jp', 'in', 'global'],
	'haiku-5-5': ['', 'us', 'ca', 'eu', 'au', 'jp', 'global'],
	'opus-4-5-20251101-v1:0': ['', 'us', 'eu', 'global'],
	'opus-4-6-v1': ['', 'us', 'eu', 'au', 'global'],
	'opus-4-7': ['', 'us', 'eu', 'jp', 'au', 'global'],
	'opus-4-8': ['', 'us', 'eu', 'jp', 'au', 'global'],
	'opus-5-5': ['', 'us', 'eu', 'jp', 'au', 'global'],
	'sonnet-4-5-20250929-v1:0': ['', 'us', 'eu', 'au', 'jp', 'global'],
	'sonnet-4-6': ['', 'us', 'eu', 'au', 'jp', 'global'],
	'sonnet-5-5': ['', 'us', 'ca', 'eu', 'au', 'global'],
};
export const bedrockVideoModels = [
	...['', 'us.', 'eu.', 'apac.', 'ca.'].map((p) => p + 'amazon.nova-lite-v1:0'),
	...['', 'us.', 'eu.', 'apac.'].map((p) => p + 'amazon.nova-pro-v1:0'),
];

/** Product and model claims checked against the linked vendor API, not inferred from compatible names. */
export function addProviderCapabilityEvidence(providerId: string, details: Map<string, ModelCatalogDetails>): void {
	const flag = (field: 'structuredOutput' | 'videoInput', models: readonly string[]) => {
		for (const model of models) details.set(model, { ...details.get(model), [field]: true });
	};
	switch (providerId) {
		case 'cerebras':
			// https://api.cerebras.ai/public/v1/models
			flag('structuredOutput', ['gpt-oss-120b', 'qwen-3.8-27b']);
			break;
		case 'azure':
			// https://learn.microsoft.com/azure/foundry/openai/how-to/structured-outputs
			flag('structuredOutput', azureSchema);
			break;
		case 'amazon-bedrock':
			// https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards-anthropic.html
			flag('structuredOutput', Object.entries(bedrockClaudeSchema).flatMap(([model, regions]) => regions.map((region) =>
				`${region ? `${region}.` : ''}anthropic.claude-${model}`)));
			// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html
			// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-pro.html
			flag('videoInput', bedrockVideoModels);
			break;
		case 'google-vertex':
			// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output
			flag('structuredOutput', vertexGemini);
			break;
		case 'groq':
			// https://console.groq.com/docs/structured-outputs#models-with-strict-mode-strict-true
			flag('structuredOutput', ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open']);
			break;
		case 'meta':
			// https://dev.meta.ai/docs/media-understanding
			flag('videoInput', ['muse-spark-1.3']);
			break;
		case 'mistral':
			// https://docs.mistral.ai/inference/conversations/structured-output/custom
			// https://docs.mistral.ai/getting-started/models/compare?models=mistral-small-4-0-26-03
			flag('structuredOutput', ['ministral-3b-latest', 'ministral-8b-latest', 'ministral-3b-2512', 'ministral-8b-2512',
				'ministral-14b-2512', 'ministral-14b-latest', 'mistral-small-2603', 'mistral-small-2506', 'mistral-small-2501',
				'mistral-large-4', 'mistral-large-4-0', 'mistral-large-latest', 'mistral-medium-3.5', 'mistral-medium-2604']);
			break;
		case 'moonshotai':
		case 'moonshotai-cn':
			// https://platform.kimi.com/docs/guide/response_format
			// https://platform.kimi.ai/docs/guide/use-kimi-vision-model
			flag('structuredOutput', ['kimi-k3.1-pro', 'kimi-k3']);
			flag('videoInput', ['kimi-k3.1-pro', 'kimi-k3']);
			break;
		case 'opencode':
			// Live Zen Generate Content probe; Go and other API families have separate catalogs.
			flag('structuredOutput', ['gemini-4-argon']);
			flag('videoInput', ['gemini-4-argon']);
			break;
		case 'nvidia':
			// https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3_1-pro
			// https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6-infer
			flag('videoInput', ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k2.6']);
			break;
		case 'xiaomi':
			// https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding
			flag('videoInput', ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']);
			break;
		case 'volcengine-doubao':
			// https://docs.volcengine.com/docs/ark/video-understanding
			flag('videoInput', ['doubao-seed-2-1-pro-260915']);
			break;
		case 'vercel-ai-gateway':
			// https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api/structured-outputs
			flag('structuredOutput', ['anthropic/claude-sonnet-5']);
			break;
	}
	if (tokenPlanIds.includes(providerId)) {
		// https://help.aliyun.com/en/model-studio/token-plan-playbook-video-digest
		flag('videoInput', ['qwen3.8-flash']);
	}
	if (['bailian-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual-cn'].includes(providerId)) {
		// https://help.aliyun.com/zh/model-studio/qwen4-max-preview (Beijing Token Plan)
		flag('structuredOutput', ['qwen4-max-preview']);
		flag('videoInput', ['qwen4-max-preview']);
	}
}
