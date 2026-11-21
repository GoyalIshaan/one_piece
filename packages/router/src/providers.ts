import type { Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

/** The providers one_piece plugs in today. Add a line here to add a provider. */
export const PROVIDER_FACTORIES: Record<string, () => Provider<any>> = {
	openai: openaiProvider,
	"openai-codex": openaiCodexProvider,
	openrouter: openrouterProvider,
	xai: xaiProvider,
	anthropic: anthropicProvider,
};
