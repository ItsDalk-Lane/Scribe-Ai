import type { Api, Model, ModelInputModality, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** 目录外的第一方服务商：按 pi 的 Model 结构补全元数据，走与内置 Provider 相同的注册与请求路径 */
export interface ExtraProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ModelInputModality[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Model<'openai-completions'>['compat'];
}

export interface ExtraProviderDef {
	id: string;
	name: string;
	baseUrl: string;
	api: Api;
	/** 复用目录内服务商的模型元数据（连同 cost/compat/inputLimits 一起），避免手抄差异 */
	cloneFrom?: string;
	/** 只克隆这些模型 id；缺省克隆全部 */
	cloneModelIds?: string[];
	models: ExtraProviderModel[];
}

// 图片预处理与 OpenAI 官方模型一致；Ark 未公开更细的限制
const IMAGE_LIMITS = {
	maxRequestBytes: 536870912,
	images: { maxPerRequest: 1500, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } },
} as const;

// 与 pi 的 Qwen Token Plan 目录一致；自定义百炼端点无法靠 URL 自动识别这些行为
const QWEN_COMPAT: NonNullable<Model<'openai-completions'>['compat']> = {
	supportsStrictMode: true,
	thinkingFormat: 'qwen',
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsReasoningEffort: false,
};
const QWEN_EFFORT_COMPAT = { ...QWEN_COMPAT, supportsReasoningEffort: true };

const QWEN4_MAX: ExtraProviderModel = {
	id: 'qwen4-max',
	name: 'Qwen4-Max',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 262_144,
	// 官方档位：low / high / xhigh；medium 会映射到 high
	thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'high', high: 'high', xhigh: 'xhigh', max: null },
	compat: QWEN_EFFORT_COMPAT,
};

const QWEN4_MAX_PREVIEW: ExtraProviderModel = {
	id: 'qwen4-max-preview',
	name: 'Qwen4-Max-Preview',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 393_216,
	// 预览版官方档位：low / medium / xhigh；预览期结束由官方下线
	thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null },
	compat: QWEN_EFFORT_COMPAT,
};

const QWEN35_PLUS: ExtraProviderModel = {
	id: 'qwen3.5-plus',
	name: 'Qwen3.5 Plus',
	reasoning: true,
	input: ['text', 'image'],
	contextWindow: 1_000_000,
	maxTokens: 65_536,
	compat: QWEN_COMPAT,
};

const BAILIAN_TOKEN_PLAN_COMMON = [
	'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus',
	'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'glm-5.3',
];

const BAILIAN_CODING_MODELS = ['qwen3.7-plus', 'qwen3.6-plus', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5'];

const BAILIAN_PAYG_MODELS = [
	'deepseek-v4-pro', 'deepseek-v4-flash-0731', 'deepseek-v4.1-flash',
	'kimi-k2.6', 'glm-5.1', 'MiniMax-M2.5',
	'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash',
];

export const MINIMAX_M_PLAN_ORIGINS: ReadonlyMap<string, string> = new Map([
	['minimax-m-plan', 'https://api.minimax.io'],
	['minimax-m-plan-cn', 'https://api.minimax.cn'],
]);

// The shared inference catalog does not identify the models included in M Plan.
// https://platform.minimax.io/docs/m-plan/intro
export const MINIMAX_M_PLAN_CHAT_MODELS = ['MiniMax-M3.1-Flash'];

export function miniMaxPlanBaseUrl(providerId: string, protocol: string): string | undefined {
	const origin = MINIMAX_M_PLAN_ORIGINS.get(providerId);
	if (!origin) return;
	if (protocol === 'anthropic-messages') return `${origin}/anthropic`;
	if (protocol === 'openai-completions' || protocol === 'openai-responses') return `${origin}/v1`;
	return undefined;
}

export function checkMiniMaxPlanKey(providerId: string, key: string): void {
	if (MINIMAX_M_PLAN_ORIGINS.has(providerId) && key.trimStart().startsWith('sk-api-')) {
		throw new Error('MiniMax M Plan 需要使用订阅密钥，请更换绑定的按量付费密钥。');
	}
}

export function isVolcengineSubscriptionProvider(providerId: string): boolean {
	return providerId === 'volcengine-agent-plan' || providerId === 'volcengine-coding-plan';
}

// The personal subscription tables and current client guide use Model Names, not pay-as-you-go version IDs.
// https://docs.volcengine.com/docs/ark/agent-plan-personal-pi?lang=zh
// https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-pi?lang=zh
const ARK_PLAN_TEXT_MODELS: ExtraProviderModel[] = [
	{ id: 'ark-code-latest', name: 'Ark Code Latest', contextWindow: 128_000, maxTokens: 16_384, input: ['text'], reasoning: false },
	...([
		['doubao-seed-evolving', 1_024, 256, true],
		['doubao-seed-2.1-pro', 1_024, 256, true],
		['doubao-seed-2.1-lite', 1_024, 256, true],
		['doubao-seed-2.0-mini', 256, 128, true],
		['glm-5.4', 1_024, 128, true],
		['glm-5.3', 1_024, 128, false],
		['glm-5.3-flash', 1_024, 128, true],
		['deepseek-v4.1-flash', 1_024, 384, true],
		['deepseek-v4.1-flash-economy', 1_024, 384, true],
		['deepseek-v4-flash', 1_024, 384, false],
		['deepseek-v4-pro', 1_024, 384, false],
		['kimi-k2.8-preview', 1_024, 128, true],
		['kimi-k3.1-pro', 1_024, 1_024, true],
	] as const).map(([id, contextK, outputK, image]): ExtraProviderModel => ({
		id, name: id, contextWindow: contextK * 1_000, maxTokens: outputK * 1_000,
		input: image ? ['text', 'image'] : ['text'], reasoning: false,
	})),
];

export const EXTRA_PROVIDERS: ExtraProviderDef[] = [
	{
		id: 'zai-payg',
		name: 'Z.AI 国际（按量付费）',
		baseUrl: 'https://api.z.ai/api/paas/v4',
		api: 'openai-completions',
		cloneFrom: 'zai',
		cloneModelIds: ['glm-5.3', 'glm-5.3-flash'],
		models: [],
	},
	{
		id: 'zai-payg-cn',
		name: '智谱中国（按量付费）',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		api: 'openai-completions',
		cloneFrom: 'zai-coding-cn',
		cloneModelIds: ['glm-5.3', 'glm-5.3-flash'],
		models: [],
	},
	...Array.from(MINIMAX_M_PLAN_ORIGINS, ([id, origin]): ExtraProviderDef => ({
		id,
		name: id === 'minimax-m-plan-cn' ? 'MiniMax M Plan（中国）' : 'MiniMax M Plan（国际）',
		baseUrl: `${origin}/anthropic`,
		api: 'anthropic-messages',
		cloneFrom: id === 'minimax-m-plan-cn' ? 'minimax-cn' : 'minimax',
		cloneModelIds: MINIMAX_M_PLAN_CHAT_MODELS,
		models: [],
	})),
	{
		id: 'volcengine-agent-plan',
		name: '火山 Agent Plan',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
		api: 'openai-completions',
		models: ARK_PLAN_TEXT_MODELS,
	},
	{
		id: 'volcengine-coding-plan',
		name: '火山 Coding Plan',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
		api: 'openai-completions',
		models: ARK_PLAN_TEXT_MODELS,
	},
	{
		id: 'bailian-token-plan',
		name: '阿里云百炼 Token Plan',
		baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
		api: 'openai-completions',
		// 个人版/团队版默认只展示官方清单的交集；套餐专属模型仍可手动添加
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_TOKEN_PLAN_COMMON,
		models: [QWEN4_MAX_PREVIEW],
	},
	{
		id: 'bailian-coding-plan',
		name: '阿里云百炼 Coding Plan',
		baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
		api: 'openai-completions',
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_CODING_MODELS,
		models: [QWEN35_PLUS],
	},
	{
		id: 'bailian-payg',
		name: '阿里云百炼（按量付费）',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		api: 'openai-completions',
		cloneFrom: 'qwen-token-plan-cn',
		cloneModelIds: BAILIAN_PAYG_MODELS,
		models: [QWEN4_MAX],
	},
	{
		id: 'volcengine-doubao',
		name: 'Volcengine Doubao',
		baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
		api: 'openai-completions',
		models: [
			{
				id: 'doubao-seed-2-1-pro-260915',
				name: 'Doubao Seed 2.1 Pro',
				// 未核实官方推理参数前按普通聊天模型调用，避免发送错误的 reasoning 字段
				reasoning: false,
				input: ['text', 'image'],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	},
];

export const EXTRA_IMAGE_LIMITS = IMAGE_LIMITS;
