import {
  defineComponent,
  tagSchemaId,
  useIsStreaming,
  useStateField
} from '@openuidev/react-lang'
import { useId, useState } from 'react'
import { z } from 'zod/v4'

import { library as intelligentUILibrary } from './intelligent-ui/base-library.ts'
import {
  dashboardPromptOptions,
  queryToolSpec
} from './intelligent-ui/prompt-options.ts'

const node = z.any()
tagSchemaId(node, 'Node')

function webUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function httpsUrl(value: string): string | null {
  const href = webUrl(value)
  return href && new URL(href).protocol === 'https:' ? href : null
}

function openStreetMapPlaceUrl(value: string): string | null {
  const href = httpsUrl(value)

  if (!href) {
    return null
  }

  const url = new URL(href)
  return url.hostname === 'www.openstreetmap.org' &&
    /^\/(?:node|way|relation)\/\d+\/?$/.test(url.pathname)
    ? href
    : null
}

const PLACE_MAP_EMBED_URL = 'https://www.openstreetmap.org/export/embed.html'
// About 2 km north-south; the longitude span keeps the iframe near 3:2.
const PLACE_MAP_LAT_SPAN = 0.018
const PLACE_MAP_ASPECT_RATIO = 1.5

function placeMapUrl(place: PlaceMapEntry): string | null {
  if (
    !place.name.trim() ||
    !Number.isFinite(place.lat) ||
    !Number.isFinite(place.lon) ||
    place.lat < -90 ||
    place.lat > 90 ||
    place.lon < -180 ||
    place.lon > 180
  ) {
    return null
  }

  const latRadians = (place.lat * Math.PI) / 180
  const latRadius = PLACE_MAP_LAT_SPAN / 2
  const lonRadius =
    (PLACE_MAP_LAT_SPAN * PLACE_MAP_ASPECT_RATIO) /
    (2 * Math.max(0.2, Math.cos(latRadians)))
  const bbox = [
    Math.max(-180, place.lon - lonRadius),
    Math.max(-90, place.lat - latRadius),
    Math.min(180, place.lon + lonRadius),
    Math.min(90, place.lat + latRadius)
  ]
    .map(value => value.toFixed(6))
    .join(',')
  const url = new URL(PLACE_MAP_EMBED_URL)

  url.searchParams.set('bbox', bbox)
  url.searchParams.set('layer', 'mapnik')
  url.searchParams.set('marker', `${place.lat.toFixed(6)},${place.lon.toFixed(6)}`)
  return url.href
}

export const CitationList = defineComponent({
  name: 'CitationList',
  description:
    'Compact ordered source list. Each source needs a title, http(s) URL, publisher, year, and optional evidence note.',
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        publisher: z.string(),
        year: z.string(),
        note: z.string().optional()
      })
    ),
    title: z.string().optional()
  }),
  component: ({ props }) => {
    const items = props.items.filter(item => item.title.trim() && item.url.trim())

    return (
      <section
        aria-label={props.title ?? 'Sources'}
        className="hermes-openui-citations"
        data-hermes-openui-citations
      >
        <h4 className="hermes-openui-citations-title">{props.title ?? 'Sources'}</h4>
        <ol className="hermes-openui-citation-list">
          {items.map((item, index) => {
            const href = webUrl(item.url)
            const attribution = [item.publisher, item.year].filter(Boolean).join(' · ')

            return (
              <li
                className="hermes-openui-citation"
                data-hermes-openui-citation
                data-safe-url={href ? 'true' : 'false'}
                key={`${item.url}-${index}`}
              >
                <div className="hermes-openui-citation-body">
                  {href ? (
                    <a
                      className="hermes-openui-citation-link"
                      href={href}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <span className="hermes-openui-citation-link">{item.title}</span>
                  )}
                  <span className="hermes-openui-citation-meta">{attribution}</span>
                  {item.note ? (
                    <span className="hermes-openui-citation-note">{item.note}</span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    )
  }
})

interface PhotoStripEntry {
  readonly alt: string
  readonly credit: string
  readonly label?: string
  readonly license: string
  readonly sourceUrl: string
  readonly src: string
}

function PhotoTile({ entry, index }: { readonly entry: PhotoStripEntry; readonly index: number }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = httpsUrl(entry.src)
  const sourceUrl = httpsUrl(entry.sourceUrl)
  const failed = !src || failedSrc === src

  return (
    <figure className="hermes-openui-photo" data-hermes-openui-photo data-photo-index={index}>
      <div
        className="hermes-openui-photo-frame"
        data-photo-state={failed ? 'fallback' : 'image'}
      >
        {!failed ? (
          <img
            alt={entry.alt}
            decoding="async"
            loading="lazy"
            onError={() => setFailedSrc(src)}
            referrerPolicy="no-referrer"
            src={src}
          />
        ) : (
          <div className="hermes-openui-photo-fallback" data-hermes-openui-photo-fallback>
            <span>{`Image unavailable: ${entry.alt}`}</span>
            {sourceUrl ? (
              <a
                className="hermes-openui-photo-source"
                href={sourceUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                View source
              </a>
            ) : null}
          </div>
        )}
      </div>
      <figcaption className="hermes-openui-photo-caption">
        {entry.label ? <span className="hermes-openui-photo-label">{entry.label}</span> : null}
        <span className="hermes-openui-photo-credit">
          {sourceUrl ? (
            <a
              className="hermes-openui-photo-source"
              href={sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {entry.credit}
            </a>
          ) : (
            entry.credit
          )}
          {entry.license ? ` · ${entry.license}` : ''}
        </span>
      </figcaption>
    </figure>
  )
}

export const PhotoStrip = defineComponent({
  name: 'PhotoStrip',
  description:
    'Two or three real photos in aligned columns. Every photo requires an https image URL, alt text, credit, license, and https source-page URL.',
  props: z.object({
    items: z
      .array(
        z.object({
          src: z.string(),
          alt: z.string(),
          label: z.string().optional(),
          credit: z.string(),
          license: z.string(),
          sourceUrl: z.string()
        })
      )
      .min(2)
      .max(3),
    title: z.string().optional()
  }),
  component: ({ props }) => {
    const items = props.items.slice(0, 3)

    return (
      <section
        aria-label={props.title ?? 'Photos'}
        className="hermes-openui-photo-strip"
        data-hermes-openui-photo-strip
      >
        {props.title ? <h4 className="hermes-openui-photo-strip-title">{props.title}</h4> : null}
        <div className="hermes-openui-photo-grid">
          {items.map((item, index) => (
            <PhotoTile entry={item} index={index} key={`${item.src}-${index}`} />
          ))}
        </div>
      </section>
    )
  }
})

interface PlaceMapEntry {
  readonly lat: number
  readonly lon: number
  readonly name: string
  readonly sourceUrl: string
}

export const PlaceMap = defineComponent({
  name: 'PlaceMap',
  description:
    'Interactive OpenStreetMap with one selected place. Coordinates are finite lat/lon values and each place links to its OpenStreetMap page.',
  props: z.object({
    places: z
      .array(
        z.object({
          name: z.string().max(80),
          lat: z.number(),
          lon: z.number(),
          sourceUrl: z.string()
        })
      )
      .min(2)
      .max(3),
    title: z.string().max(80).optional()
  }),
  component: ({ props, statementId }) => {
    const fallbackId = useId()
    const streaming = useIsStreaming()
    const selection = useStateField<number>(
      statementId ?? `place-map-${fallbackId}`,
      0
    )
    const safeIndex =
      Number.isInteger(selection.value) &&
      selection.value >= 0 &&
      selection.value < props.places.length
        ? selection.value
        : 0
    const selected = props.places[safeIndex]
    const embedUrl = selected ? placeMapUrl(selected) : null
    const sourceUrl = selected ? openStreetMapPlaceUrl(selected.sourceUrl) : null

    return (
      <section
        aria-label={props.title ?? 'Places on OpenStreetMap'}
        className="hermes-openui-place-map"
        data-hermes-openui-place-map
        data-selected-place={selected?.name ?? ''}
      >
        {props.title ? <h4 className="hermes-openui-place-map-title">{props.title}</h4> : null}
        <div className="hermes-openui-place-map-frame">
          {embedUrl ? (
            <iframe
              className="hermes-openui-place-map-embed"
              key={embedUrl}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin"
              src={embedUrl}
              title={`${selected?.name ?? 'Selected place'} on OpenStreetMap`}
            />
          ) : (
            <div className="hermes-openui-place-map-fallback" role="status">
              <span>Map unavailable for this place.</span>
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open place on OpenStreetMap
                </a>
              ) : null}
            </div>
          )}
          <label className="hermes-openui-place-map-selector">
            <select
              aria-label="Choose a place on the map"
              disabled={streaming}
              onChange={event => selection.setValue(Number(event.currentTarget.value))}
              value={safeIndex}
            >
              {props.places.map((place, index) => (
                <option key={`${place.name}-${index}`} value={index}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer className="hermes-openui-place-map-footer">
          {sourceUrl ? (
            <a
              className="hermes-openui-place-map-open"
              href={sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {selected?.name ?? 'Selected place'} on OpenStreetMap ↗
            </a>
          ) : (
            <span>{selected?.name ?? 'Selected place'}</span>
          )}
          <a
            href="https://www.openstreetmap.org/copyright"
            rel="noopener noreferrer"
            target="_blank"
          >
            Map data © OpenStreetMap contributors
          </a>
        </footer>
      </section>
    )
  }
})

/**
 * The complete Open Intelligent UI library, plus the three attribution-aware
 * leaves used by the Hermes examples. The upstream root remains `Col`, its
 * component names and argument order remain unchanged.
 */
export const openUILibrary = intelligentUILibrary.extend({
  components: {
    add: [CitationList, PhotoStrip, PlaceMap]
  }
})

export const DESIGN_OPENUI_PROGRAM = `root = Col([header, metrics, comparison, note, follow], 4)
header = Col([Title("Choose a retrieval strategy", "xl"), Text("Hybrid is the safer default for mixed exact-match and semantic queries.", "md", "muted")], 2)
metrics = Grid([metric1, metric2, metric3], 3, 180, 3)
metric1 = Card([Caption("Balanced"), Title("Hybrid", "xl"), Text("No axis in last place.", "sm")], "soft", 3, 2)
metric2 = Card([Caption("Quality"), Title("94", "xl"), Text("Semantic view.", "sm")], "soft", 3, 2)
metric3 = Card([Caption("Speed"), Title("90", "xl"), Text("Graph view.", "sm")], "soft", 3, 2)
$lens = "Quality"
$minimum = 75
comparison = Card([Row([Title("Illustrative scores", "md"), Spacer(), SegmentedControl($lens, ["Quality", "Speed", "Efficiency"])], 3), Chart("bar", scores, "system", [$lens], "percent", null, null, 240), Slider($minimum, 50, 95, 5, "Evidence floor", "%"), Text("Showing " + $lens + " scores; " + $minimum + "% is the evidence floor.", "sm")], "outline", 4, 3)
scores = [{ system: "Hybrid", Quality: 88, Speed: 82, Efficiency: 74 }, { system: "Semantic", Quality: 94, Speed: 61, Efficiency: 69 }, { system: "Graph", Quality: 76, Speed: 90, Efficiency: 86 }]
note = Caption("Illustrative 0-100 scores, not measured benchmarks.")
follow = Button("Explain this trade-off", @ToAssistant("Explain the " + $lens + " comparison above " + $minimum + "% evidence floor."))`

export const DECISION_BRIEF_OPENUI_PROGRAM = `root = Col([header, signals, viewTabs, details, sources, follow], 4)
header = Col([Title("Choose a retrieval path", "xl"), Text("A cited recommendation for queries that mix names, codes, and semantic intent.", "md", "muted")], 2)
signals = Grid([signal1, signal2, signal3], 3, 180, 3)
signal1 = Card([Caption("Exact matches"), Title("BM25", "xl"), Text("Strong for names and identifiers.", "sm")], "soft", 3, 2)
signal2 = Card([Caption("Semantic recall"), Title("DPR", "xl"), Text("Strong for paraphrases.", "sm")], "soft", 3, 2)
signal3 = Card([Caption("Combined ranking"), Title("RRF", "xl"), Text("Merges ranked lists without score calibration.", "sm")], "soft", 3, 2)
$view = "Decision"
viewTabs = Row([Caption("View"), Spacer(), SegmentedControl($view, ["Decision", "Evidence", "Caveats"])], 3)
details = $view == "Decision" ? Card([Title("Recommendation", "md"), Text("Start with hybrid retrieval: combine BM25 and dense rankings, then evaluate on your own query set.", "sm")], "outline", 4, 2) : $view == "Evidence" ? Card([Title("Evidence", "md"), Text("BM25 supplies a lexical baseline, DPR supplies dense dual-encoder retrieval, and reciprocal rank fusion combines ranked lists without score calibration.", "sm")], "outline", 4, 2) : Card([Title("Caveats", "md"), Text("Exact identifiers favor lexical matching, while paraphrases favor dense retrieval. Fusion can add latency and does not guarantee better ranking.", "sm")], "outline", 4, 2)
sources = CitationList([{ title: "The Probabilistic Relevance Framework: BM25 and Beyond", url: "https://doi.org/10.1561/1500000019", publisher: "Foundations and Trends in Information Retrieval", year: "2009" }, { title: "Dense Passage Retrieval for Open-Domain Question Answering", url: "https://arxiv.org/abs/2004.04906", publisher: "EMNLP", year: "2020" }, { title: "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods", url: "https://doi.org/10.1145/1571941.1572114", publisher: "ACM SIGIR", year: "2009" }], "Sources")
follow = Button("Draft an evaluation plan", @ToAssistant("Draft an evaluation plan for hybrid retrieval using the " + $view + " view. Require citations and report recall, identifier accuracy, latency, and ranking quality."))`

export const PHOTO_STRIP_OPENUI_PROGRAM = `root = Col([header, photos, map, follow], 4)
header = Col([Title("Three views of San Francisco", "xl"), Text("A landmark, a park, and a ride that show different sides of the city.", "md", "muted")], 2)
photos = PhotoStrip([{ src: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Golden_Gate_Bridge_at_sunset_1.jpg/1280px-Golden_Gate_Bridge_at_sunset_1.jpg", alt: "Golden Gate Bridge at sunset above the bay", label: "Golden Gate Bridge", credit: "Brocken Inaglory", license: "CC BY-SA 3.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:Golden_Gate_Bridge_at_sunset_1.jpg" }, { src: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Palace_of_Fine_Arts_San_Francisco_January_2014_003.jpg/1280px-Palace_of_Fine_Arts_San_Francisco_January_2014_003.jpg", alt: "Palace of Fine Arts reflected in the lagoon", label: "Palace of Fine Arts", credit: "King of Hearts", license: "CC BY-SA 4.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:Palace_of_Fine_Arts_San_Francisco_January_2014_003.jpg" }, { src: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/San_Francisco_Cable_Car_55_dllu.jpg/1280px-San_Francisco_Cable_Car_55_dllu.jpg", alt: "San Francisco cable car 55 climbing a city street", label: "Cable car 55", credit: "Dllu", license: "CC BY-SA 4.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:San_Francisco_Cable_Car_55_dllu.jpg" }], "City landmarks")
map = PlaceMap([{ name: "Golden Gate Bridge", lat: 37.8182923, lon: -122.4783842, sourceUrl: "https://www.openstreetmap.org/relation/21407754" }, { name: "Palace of Fine Arts", lat: 37.8029186, lon: -122.4484029, sourceUrl: "https://www.openstreetmap.org/way/288371295" }, { name: "Powell & Market cable car", lat: 37.7848858, lon: -122.4077300, sourceUrl: "https://www.openstreetmap.org/node/1578907655" }], "Three stops on the map")
follow = Button("Plan a photo walk", @ToAssistant("Plan a compact San Francisco photo walk for the Golden Gate Bridge, Palace of Fine Arts, and California Street cable car."))`

export const OPENUI_PROMPT = openUILibrary.prompt({
  preamble:
    'When an answer benefits from an interactive visual explanation, compose an OpenUI page using the complete Open Intelligent UI component system.',
  additionalRules: [
    'Use Col as the root. Start with root so forward references can render progressively.',
    ...(dashboardPromptOptions.additionalRules ?? []),
    'Bind SegmentedControl and Slider values to $variables. Every control must change visible content or an explicit follow-up.',
    'Do not use fixture, demo, design, or component vocabulary in user-visible labels.',
    'Do not explain how controls work in prose. Make each control change visible content and end with one task-specific follow-up.',
    'If scores are illustrative, disclose that once in a final Caption. Use CitationList with real titles, publishers, years, and http(s) URLs instead of invented sources.',
    'Use PhotoStrip only for two or three real photos supplied by the user or a trusted tool. Give each photo an https image URL, alt text, credit, license, and https source page.',
    'Use PlaceMap only with verified coordinates and OpenStreetMap place URLs. The component builds its own embed URL, shows one selected marker, and invents no routes, schedules, or transit claims.',
    'Do not invent photographs or map geometry, and do not fetch citation metadata in the browser.',
    'Use Query("query_data", args, {rows: []}) only when the user asks for data from the read-only endpoint configured in the Hermes plugin settings. Never substitute fixture or demo rows when the source is unavailable.',
    'Keep text outside the directive to one concise takeaway before it. Do not append a second summary after the directive.'
  ],
  examples: dashboardPromptOptions.examples ?? [],
  tools: [queryToolSpec],
  toolExamples: dashboardPromptOptions.toolExamples ?? []
})

export const SAMPLE_OPENUI_PROGRAM = `root = Col([header, filter], 4)
header = Col([Title("Filter results", "xl"), Text("Move the threshold to narrow the set locally.", "md", "muted")], 2)
$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this " + $minimum + "% relevance threshold."))
filter = Card([slider, readout, follow], "soft", 4, 3)`
