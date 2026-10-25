import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// OmO's bundled compat module may omit this registrar; a named import breaks extension load.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
	getApiKey,
	loginAntigravity,
	refreshAntigravityToken,
	rememberAccount,
	updateRememberedAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { registerAntigravityCommands } from "./commands/index.js";
import { registerFileAttachments } from "./files/index.js";
import { generateAntigravityImages } from "./image/index.js";
import {
	ANTIGRAVITY_IMAGE_API,
	createPricingResolver,
	getCurrentAntigravityCatalog,
	listProviderModels,
	PROVIDER_ID,
	PROVIDER_NAME,
	refreshAntigravityModels,
	type PricingSources,
} from "./models/index.js";
import { AccountCredentialSource } from "./runtime/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import { registerAntigravityTools } from "./tools/index.js";

type LoginCallbacks = Parameters<typeof loginAntigravity>[0];
type RefreshCallbacks = Parameters<typeof refreshAntigravityToken>[0];
type CompatApiProviderRegistrar = (provider: {
	api: typeof ANTIGRAVITY_API;
	stream: typeof streamAntigravity;
	streamSimple: typeof streamAntigravity;
}) => void;

async function loginAndRemember(callbacks: LoginCallbacks): ReturnType<typeof loginAntigravity> {
	const credentials = await loginAntigravity(callbacks);
	rememberAccount(credentials);
	return credentials;
}

async function refreshAndRemember(
	credentials: RefreshCallbacks,
): ReturnType<typeof refreshAntigravityToken> {
	const refreshed = await refreshAntigravityToken(credentials);
	updateRememberedAccount(credentials, refreshed);
	return refreshed;
}

export default function(pi: ExtensionAPI): void {
	// Keep the context-owned registry private to this extension instance. Lookups are
	// lazy so an already-selected model also sees prices refreshed during the session.
	let registryLookup: PricingSources["find"];
	const resolveCost = createPricingResolver({
		find: (provider, id) => registryLookup?.(provider, id),
	});
	const defaultCredentialSource = new AccountCredentialSource();
	const boundStreamAntigravity: typeof streamAntigravity = (model, context, options) =>
		streamAntigravity(model, context, {
			...options,
			credentialSource: options?.credentialSource ?? defaultCredentialSource,
			pricingResolver: options?.pricingResolver ?? resolveCost,
		});
	const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
		.registerApiProvider;
	if (typeof register === "function") {
		register({
			api: ANTIGRAVITY_API,
			stream: boundStreamAntigravity,
			streamSimple: boundStreamAntigravity,
		});
	}
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: DEFAULT_ENDPOINT,
		api: ANTIGRAVITY_API,
		models: listProviderModels(getCurrentAntigravityCatalog(), resolveCost),
		refreshModels: (context) => refreshAntigravityModels(context, resolveCost),
		images: {
			[ANTIGRAVITY_IMAGE_API]: {
				generateImages: generateAntigravityImages,
			},
		},
		oauth: {
			name: PROVIDER_NAME,
			login: loginAndRemember,
			refreshToken: refreshAndRemember,
			getApiKey,
		},
		streamSimple: boundStreamAntigravity,
	});

	pi.on("session_start", (_event, ctx) => {
		registryLookup = (provider, id) => ctx.modelRegistry.find(provider, id);
	});
	pi.on("session_shutdown", () => {
		registryLookup = undefined;
	});

	registerAntigravityCommands(pi);
	registerAntigravityTools(pi);
	registerFileAttachments(pi);
}
