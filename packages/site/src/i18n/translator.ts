import type { SupportedLocale } from "@lurkloot/shared/models";
import { translationSystemPrompt } from "./prompt.ts";

export { translationSystemPrompt } from "./prompt.ts";

export const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export interface TranslationItem {
  id: string;
  text: string;
}

export interface Translator {
  translate(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<TranslationItem[]>;
}

interface ScoutTranslatorOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

interface ScoutResponse {
  success?: boolean;
  result?: {
    response?: unknown;
  };
  errors?: unknown;
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}

class MissingTranslationIdsError extends Error {
  constructor(missingIds: string[]) {
    super(`Scout translation response is missing ids: ${missingIds.join(", ")}`);
    this.name = "MissingTranslationIdsError";
  }
}

function parseTranslationItems(value: string): TranslationItem[] {
  const parsed: unknown = JSON.parse(stripMarkdownFence(value));
  if (!Array.isArray(parsed)) {
    throw new Error("Scout translation response must be a JSON array");
  }
  if (!parsed.every(
    (item): item is TranslationItem =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as TranslationItem).id === "string" &&
      typeof (item as TranslationItem).text === "string",
  )) {
    throw new Error("Scout translation response contains an invalid item");
  }
  return parsed;
}

function isRetryableScoutRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Scout translation request failed");
}

function shouldSplitBatch(error: unknown, itemCount: number): boolean {
  if (itemCount <= 1) return false;
  return error instanceof SyntaxError || error instanceof MissingTranslationIdsError;
}

export class ScoutTranslator implements Translator {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ accountId, apiToken, fetchImpl = fetch }: ScoutTranslatorOptions) {
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
  }

  async translate(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<TranslationItem[]> {
    if (input.items.length === 0) return [];

    try {
      return await this.translateBatch(input);
    } catch (error) {
      if (!shouldSplitBatch(error, input.items.length)) throw error;
      const midpoint = Math.ceil(input.items.length / 2);
      const left = await this.translate({ locale: input.locale, items: input.items.slice(0, midpoint) });
      const right = await this.translate({ locale: input.locale, items: input.items.slice(midpoint) });
      return [...left, ...right];
    }
  }

  private async translateBatch(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<TranslationItem[]> {
    const body = await this.requestScout(input);
    const translations = parseTranslationItems(body.result?.response as string);
    const returnedIds = new Set(translations.map((item) => item.id));
    const missingIds = input.items.filter((item) => !returnedIds.has(item.id)).map((item) => item.id);
    if (missingIds.length > 0) {
      throw new MissingTranslationIdsError(missingIds);
    }
    return translations;
  }

  private async requestScout(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<ScoutResponse> {
    try {
      return await this.requestScoutOnce(input);
    } catch (error) {
      if (!isRetryableScoutRequestError(error)) throw error;
      return await this.requestScoutOnce(input);
    }
  }

  private async requestScoutOnce(input: {
    locale: Exclude<SupportedLocale, "en">;
    items: TranslationItem[];
  }): Promise<ScoutResponse> {
    const response = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${SCOUT_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: translationSystemPrompt(input.locale) },
            { role: "user", content: JSON.stringify(input.items) },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Scout translation request failed with HTTP ${response.status}`);
    }

    const body = await response.json() as ScoutResponse;
    if (body.success === false) {
      throw new Error(`Scout translation request failed: ${JSON.stringify(body.errors ?? [])}`);
    }
    if (typeof body.result?.response !== "string") {
      throw new Error("Scout translation response is missing result.response");
    }
    return body;
  }
}
