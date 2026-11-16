"use client";

import { defineComponent } from "@openuidev/react-lang";
import { ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { Glyph } from "./glyph";
import { color, cx, fg, radius, radiusSchema, webUrl } from "./style";

const ICON_SIZE = { sm: 14, md: 18, lg: 24, xl: 32 } as const;

export const Icon = defineComponent({
  name: "Icon",
  props: z.object({
    name: z.string(),
    size: z.enum(["sm", "md", "lg", "xl"]).optional(),
    color: color.optional(),
  }),
  description: 'Lucide icon by name, e.g. "map-pin".',
  component: ({ props }) => (
    <span className="iui-icon" style={{ color: fg(props.color) }}>
      <Glyph name={props.name} size={ICON_SIZE[props.size ?? "md"] ?? 18} />
    </span>
  ),
});

// Image search
const searches = new Map<string, Promise<string[]>>();

const urls = (value: unknown) => (Array.isArray(value) ? value.flatMap((u) => (webUrl(u) ? [u as string] : [])) : []);

/**
 * Photo URLs for a query directly from Wikipedia's public MediaWiki API.
 * Hermes has no application API route, so the component must not depend on
 * the upstream demo server. A failed or empty lookup removes the cache entry
 * and can be retried on a later mount.
 */
function searchImages(query: string): Promise<string[]> {
  let request = searches.get(query);
  if (!request) {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "0",
      gsrlimit: "6",
      prop: "pageimages",
      piprop: "thumbnail|original",
      pithumbsize: "1200",
      format: "json",
      origin: "*",
    }).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    request = fetch(url, { signal: controller.signal })
      .then(async (response): Promise<Record<string, unknown>> =>
        response.ok ? ((await response.json()) as Record<string, unknown>) : {},
      )
      .then((body) => {
        const pages = body.query && typeof body.query === "object"
          ? (body.query as { pages?: unknown }).pages
          : null;
        const candidates = pages && typeof pages === "object"
          ? Object.values(pages as Record<string, unknown>).flatMap((page) => {
              if (!page || typeof page !== "object") return [];
              const record = page as Record<string, unknown>;
              const thumbnail = record.thumbnail && typeof record.thumbnail === "object"
                ? (record.thumbnail as { source?: unknown }).source
                : null;
              const original = record.original && typeof record.original === "object"
                ? (record.original as { source?: unknown }).source
                : null;
              return [...urls([thumbnail]), ...urls([original])];
            })
          : [];
        const all = [...new Set(candidates)];
      if (!all.length) searches.delete(query);
        return all;
      })
      .catch(() => {
        searches.delete(query);
        return [];
      })
      .finally(() => clearTimeout(timeout));
    if (searches.size > 200) searches.delete(searches.keys().next().value!);
    searches.set(query, request);
  }
  return request;
}

/** Search results for `query`, or undefined while waiting. The query settles first: it may still be streaming. */
function useImageSearch(query: string | null): string[] | undefined {
  const [result, setResult] = useState<{ query: string; images: string[] } | null>(null);
  useEffect(() => {
    if (!query) return;
    let active = true;
    const timer = setTimeout(() => {
      searchImages(query).then((images) => {
        if (active) setResult({ query, images });
      });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  return query && result?.query === query ? result.images : undefined;
}

type PhotoProps = { query: string; src?: string | null; aspectRatio?: number | null; radius?: unknown; fit?: string | null };

/** A photo from src, or, without one or when it fails, the best search result for query. */
function Photo(props: PhotoProps) {
  const alt = typeof props.query === "string" ? props.query.trim() : "";
  const src = webUrl(props.src);
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const needSearch = (!src || failed.includes(src)) && alt.length > 2;
  const found = useImageSearch(needSearch ? alt : null);
  const current = [src, ...(found ?? [])].find((url): url is string => !!url && !failed.includes(url));
  const settled = !current && (!needSearch || found !== undefined);
  const ratio = typeof props.aspectRatio === "number" && props.aspectRatio > 0.2 && props.aspectRatio < 5 ? props.aspectRatio : 1.5;
  return (
    <div
      className={cx("iui-image", props.fit === "contain" && "is-contain", loaded === current && "is-loaded")}
      style={{ aspectRatio: ratio, borderRadius: radius(props.radius ?? "lg") }}
      role={current ? undefined : "img"}
      aria-label={current ? undefined : alt}
    >
      {current ? (
        <img
          key={current}
          src={current}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(current)}
          onError={() => setFailed((list) => [...list, current])}
        />
      ) : settled ? (
        <ImageIcon aria-hidden className="iui-image-empty" strokeWidth={1.5} />
      ) : null}
    </div>
  );
}

const fit = z.enum(["cover", "contain"]).optional();

export const SearchImage = defineComponent({
  name: "SearchImage",
  props: z.object({ query: z.string(), aspectRatio: z.number().optional(), radius: radiusSchema.optional(), fit }),
  description:
    'A real photo the app finds for query; it needs no URL and no tool. Name the exact thing in 2 to 4 words: "Belém Tower Lisbon", "iPhone 17", "pastel de nata". Use one for every place, dish, product or thing with a look.',
  component: ({ props }) => <Photo {...props} />,
});

export const Image = defineComponent({
  name: "Image",
  props: z.object({ src: z.string(), alt: z.string(), aspectRatio: z.number().optional(), radius: radiusSchema.optional(), fit }),
  description: "Photo from a URL the user or a tool gave; if it fails, a photo is found for alt.",
  component: ({ props }) => <Photo query={props.alt} src={props.src} aspectRatio={props.aspectRatio} radius={props.radius} fit={props.fit} />,
});
