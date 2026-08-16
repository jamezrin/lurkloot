import { englishCopy } from "./copy/en.ts";

export type FaqItem = { q: string; a: string };
export const faqItems: FaqItem[] = englishCopy.faq.items.map((item) => ({ q: item.q, a: item.a }));
