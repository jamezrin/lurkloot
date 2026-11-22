import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { GUIDE_SECTIONS, SUPPORT_LEVELS } from "./guide";

// The user guide at /guide. Each page is a Markdown file under
// src/content/guide/<section>/; the folder only groups files; the page's
// `section` frontmatter decides where it appears in the navigation.
const guide = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/guide" }),
  schema: z.object({
    title: z.string(),
    // Used for the meta description and the guide index card. Keep it to one
    // plain sentence that answers "what will this page help me do?".
    description: z.string(),
    section: z.enum(GUIDE_SECTIONS.map((section) => section.id) as [string, ...string[]]),
    order: z.number(),
    // Where the feature on this page works. Shown under the title and collected
    // into the comparison table on the "Extension or CLI?" page. Leave it out
    // for pages that are not about one feature.
    support: z
      .object({
        extension: z.enum(SUPPORT_LEVELS),
        cli: z.enum(SUPPORT_LEVELS),
        // One short sentence on what differs, in the reader's terms.
        note: z.string().optional(),
      })
      .optional(),
    // Renders the feature comparison table built from every page's `support`.
    supportTable: z.boolean().optional(),
  }),
});

export const collections = { guide };
