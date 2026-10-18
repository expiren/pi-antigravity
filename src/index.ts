import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Namespace import: Oh My Pi rewrites this specifier onto bundled pi-ai, which
// does not export registerApiProvider. A static named import fails plugin load.
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
  getCurrentAntigravityCatalog,
  listProviderModels,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
} from "./models/index.js";
import { AccountCredentialSource } from "./runtime/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import { registerAntigravityTools } from "./tools/index.js";

type LoginCallbacks = Parameters<typeof loginAntigravity>[0];
type RefreshCallbacks = Parameters<typeof refreshAntigravityToken>[0];

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

type CompatApiProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_API;
  stream: typeof streamAntigravity;
  streamSimple: typeof streamAntigravity;
}) => void;

const defaultCredentialSource = new AccountCredentialSource();

const boundStreamAntigravity: typeof streamAntigravity = (model, context, options) =>
  streamAntigravity(model, context, {
    ...options,
    credentialSource: options?.credentialSource ?? defaultCredentialSource,
  });

/**
 * Pi dispatches custom APIs through the compat registry. Oh My Pi does not
 * export `registerApiProvider` and registers the stream inside `registerProvider`.
 */
function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register !== "function") return;
  register({
    api: ANTIGRAVITY_API,
    stream: boundStreamAntigravity,
    streamSimple: boundStreamAntigravity,
  });
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: listProviderModels(getCurrentAntigravityCatalog()),
    refreshModels: refreshAntigravityModels,
    // Hosts that predate Pi 1.0 ignore this. generate_image then calls the local transport.
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

  registerAntigravityCommands(pi);
  registerAntigravityTools(pi);
  registerFileAttachments(pi);
}
