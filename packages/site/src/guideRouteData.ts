// Adjusts what Starlight puts in each guide page's <head> so it matches the
// rest of the site (layouts/Base.astro): canonical URLs without a trailing
// slash, the shared social image, and a breadcrumb trail.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { LINKS, SITE } from "./consts";

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const canonical = new URL(context.url.pathname, SITE.url).href.replace(/\/$/, "");
  const ogImage = `${SITE.url}/og.png`;

  for (const item of route.head) {
    if (item.tag === "link" && item.attrs?.rel === "canonical") item.attrs.href = canonical;
    if (item.tag === "meta" && item.attrs?.property === "og:url") item.attrs.content = canonical;
  }

  const crumbs = [
    { name: "Home", href: "/" },
    { name: "Guide", href: LINKS.guide },
  ];
  if (route.id !== "guide")
    crumbs.push({ name: route.entry.data.title, href: context.url.pathname });
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.href, SITE.url).href.replace(/\/$/, ""),
    })),
  };

  route.head.push(
    { tag: "meta", attrs: { name: "author", content: "jamezrin" } },
    { tag: "meta", attrs: { name: "theme-color", content: "#000000" } },
    { tag: "meta", attrs: { name: "color-scheme", content: "dark" } },
    { tag: "link", attrs: { rel: "apple-touch-icon", href: "/icon-128.png" } },
    { tag: "meta", attrs: { property: "og:image", content: ogImage } },
    { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
    { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
    { tag: "meta", attrs: { name: "twitter:image", content: ogImage } },
    {
      tag: "script",
      attrs: { type: "application/ld+json" },
      content: JSON.stringify(breadcrumbs),
    },
  );
});
