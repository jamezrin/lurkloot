import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { SUPPORT_LEVELS } from "./guide";

// The user guide at /guide, rendered by Starlight. Each page is a Markdown (or
// MDX) file under src/content/docs/guide/<section>/; src/guide.ts orders the
// sections and `sidebar.order` orders the pages inside one.
const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema({
    extend: z.object({
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
    }),
  }),
});

export const collections = { docs };
