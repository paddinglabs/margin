import type { APIRoute } from "astro";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPalette,
  highlightBg,
  highlightInk,
} from "../views/reading-room/theme";

function getPublicDir(): string {
  if (import.meta.env.PROD) {
    return join(process.cwd(), "dist", "client");
  }
  return join(process.cwd(), "public");
}

let fontsLoaded: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;

function loadFonts() {
  if (fontsLoaded) return fontsLoaded;
  const publicDir = getPublicDir();
  fontsLoaded = {
    regular: readFileSync(join(publicDir, "fonts", "Inter-Regular.ttf"))
      .buffer as ArrayBuffer,
    bold: readFileSync(join(publicDir, "fonts", "Inter-Bold.ttf"))
      .buffer as ArrayBuffer,
  };
  return fontsLoaded;
}

// Fallback fonts for scripts Inter does not cover (CJK, Thai, Arabic, ...),
// keyed by the language codes satori passes to loadAdditionalAsset.
const FALLBACK_FONT_FAMILIES: Record<string, string> = {
  "ja-JP": "Noto Sans JP",
  "ko-KR": "Noto Sans KR",
  "zh-CN": "Noto Sans SC",
  "zh-TW": "Noto Sans TC",
  "zh-HK": "Noto Sans HK",
  "th-TH": "Noto Sans Thai",
  "bn-IN": "Noto Sans Bengali",
  "ar-AR": "Noto Sans Arabic",
  "ta-IN": "Noto Sans Tamil",
  "ml-IN": "Noto Sans Malayalam",
  "he-IL": "Noto Sans Hebrew",
  "te-IN": "Noto Sans Telugu",
  devanagari: "Noto Sans Devanagari",
  kannada: "Noto Sans Kannada",
  symbol: "Noto Sans Symbols",
  math: "Noto Sans Math",
  unknown: "Noto Sans",
};

const FALLBACK_WEIGHTS = [400, 700] as const;
type FallbackWeight = (typeof FALLBACK_WEIGHTS)[number];

type FallbackFont = {
  name: string;
  data: ArrayBuffer;
  weight: FallbackWeight;
  style: "normal";
};

const fallbackFontCache = new Map<string, Promise<FallbackFont[]>>();
const FALLBACK_FONT_CACHE_LIMIT = 200;
let fallbackFontSubsetId = 0;

// Matches one @font-face block: "@font-face { font-weight: 400; ... }", not "@media { ... }".
const FONT_FACE_RE = /@font-face\s*{([^}]*)}/g;
// Matches "font-weight: 700", not "font-style: normal".
const FONT_WEIGHT_RE = /font-weight:\s*(\d+)/;
// Matches "src: url(https://...) format('truetype')", not "format('woff2')".
const FONT_SRC_RE = /src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/;

function isFallbackWeight(weight: number): weight is FallbackWeight {
  return (FALLBACK_WEIGHTS as readonly number[]).includes(weight);
}

async function fetchFontFace(
  name: string,
  weight: FallbackWeight,
  src: string,
): Promise<FallbackFont | null> {
  const res = await fetch(src);
  if (!res.ok) return null;
  return {
    name,
    data: await res.arrayBuffer(),
    weight,
    style: "normal",
  };
}

async function fetchFallbackFonts(
  family: string,
  text: string,
): Promise<FallbackFont[]> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  )}:wght@${FALLBACK_WEIGHTS.join(";")}&text=${encodeURIComponent(text)}`;
  // Without a browser User-Agent Google Fonts serves TrueType, which satori can parse.
  const cssRes = await fetch(cssUrl);
  if (!cssRes.ok) return [];
  const css = await cssRes.text();

  const faces = [...css.matchAll(FONT_FACE_RE)].flatMap(([, body]) => {
    const weight = Number(FONT_WEIGHT_RE.exec(body)?.[1]);
    const src = FONT_SRC_RE.exec(body)?.[1];
    return src && isFallbackWeight(weight) ? [{ weight, src }] : [];
  });

  // Each subset needs its own name: satori keeps only the first font per name and weight.
  const name = `${family} ${++fallbackFontSubsetId}`;
  const fonts = await Promise.all(
    faces.map(({ weight, src }) => fetchFontFace(name, weight, src)),
  );
  return fonts.filter((f): f is FallbackFont => f !== null);
}

async function fetchFallbackFontsSafe(
  family: string,
  text: string,
  key: string,
): Promise<FallbackFont[]> {
  try {
    const fonts = await fetchFallbackFonts(family, text);
    if (fonts.length === 0) fallbackFontCache.delete(key);
    return fonts;
  } catch (e) {
    console.error(`[og-image] Failed to load fallback font ${family}:`, e);
    fallbackFontCache.delete(key);
    return [];
  }
}

function loadFallbackFont(
  family: string,
  segment: string,
): Promise<FallbackFont[]> {
  const text = [...new Set(segment)].sort().join("");
  const key = `${family}\u0000${text}`;

  const cached = fallbackFontCache.get(key);
  if (cached) return cached;

  if (fallbackFontCache.size >= FALLBACK_FONT_CACHE_LIMIT) {
    const oldest = fallbackFontCache.keys().next().value;
    if (oldest !== undefined) fallbackFontCache.delete(oldest);
  }
  const promise = fetchFallbackFontsSafe(family, text, key);
  fallbackFontCache.set(key, promise);
  return promise;
}

// Satori may pass several candidates joined by "|", e.g. "ja-JP|zh-CN" for kanji.
async function loadFallbackFonts(
  languageCodes: string,
  segment: string,
): Promise<FallbackFont[]> {
  const families = [
    ...new Set(
      languageCodes
        .split("|")
        .map(
          (code) =>
            FALLBACK_FONT_FAMILIES[code] ?? FALLBACK_FONT_FAMILIES.unknown,
        ),
    ),
  ];
  const fonts = await Promise.all(
    families.map((family) => loadFallbackFont(family, segment)),
  );
  return fonts.flat();
}

const API_URL = process.env.API_URL || "http://localhost:8081";

interface RecordData {
  type: "annotation" | "highlight" | "bookmark" | "collection";
  author: string;
  displayName: string;
  avatarURL: string;
  text: string;
  quote: string;
  source: string;
  title: string;
  icon: string;
  description: string;
  color: string;
}

function normalizeAvatarUrl(avatar: string): string {
  if (!avatar) return "";
  if (!avatar.includes("cdn.bsky.app") && !avatar.includes("bsky")) {
    return avatar;
  }
  return (
    avatar.replace(/@[a-z]+$/, "@jpeg") +
    (/@[a-z]+$/.test(avatar) ? "" : "@jpeg")
  );
}

async function resolveAvatarUrl(did: string): Promise<string> {
  if (!did) return "";
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (!res.ok) return "";
    const profile = await res.json();
    return normalizeAvatarUrl(profile.avatar || "");
  } catch {
    return "";
  }
}

async function fetchImageDataUri(url: string): Promise<string> {
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "margin.at/og" } });
    if (!res.ok) return "";
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    const b64 = Buffer.from(buf).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return "";
  }
}

async function fetchAvatarDataUri(did: string): Promise<string> {
  return fetchImageDataUri(await resolveAvatarUrl(did));
}

async function fetchRecordData(uri: string): Promise<RecordData | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/note?uri=${encodeURIComponent(uri)}`,
    );
    if (res.ok) {
      const item = await res.json();
      const author = item.author || item.creator || {};
      const handle = author.handle || "";
      const did = author.did || "";
      const authorName = handle ? `@${handle}` : did || "someone";
      const displayName = author.displayName || handle || did || "someone";
      const avatarURL = await fetchAvatarDataUri(author.did || "");
      const targetSource = item.target?.source || item.url || item.source || "";
      const domain = targetSource
        ? (() => {
            try {
              return new URL(targetSource).hostname.replace(/^www\./, "");
            } catch {
              return "";
            }
          })()
        : "";
      const selectorText =
        item.target?.selector?.exact || item.selector?.exact || "";
      const bodyText =
        extractBody(item.body) || item.bodyValue || item.text || "";
      const motivation = item.motivation || "";
      const targetTitle = item.target?.title || item.title || "";

      if (
        motivation === "highlighting" ||
        uri.includes("/at.margin.highlight/")
      ) {
        return {
          type: "highlight",
          author: authorName,
          displayName,
          avatarURL,
          text: targetTitle,
          quote: selectorText,
          source: domain,
          title: "",
          icon: "",
          description: "",
          color: item.color || "",
        };
      }

      if (uri.includes("/at.margin.bookmark/")) {
        return {
          type: "bookmark",
          author: authorName,
          displayName,
          avatarURL,
          text: item.title || targetTitle || "Bookmark",
          quote: item.description || bodyText || "",
          source: domain,
          title: "",
          icon: "",
          description: "",
          color: "",
        };
      }

      return {
        type: "annotation",
        author: authorName,
        displayName,
        avatarURL,
        text: bodyText,
        quote: selectorText,
        source: domain,
        title: "",
        icon: "",
        description: "",
        color: "",
      };
    }
  } catch {
    /* fall through */
  }

  try {
    const res = await fetch(
      `${API_URL}/api/collection?uri=${encodeURIComponent(uri)}`,
    );
    if (res.ok) {
      const item = await res.json();
      const author = item.author || item.creator || {};
      const handle = author.handle || "";
      const did = author.did || "";
      const authorName = handle ? `@${handle}` : did || "someone";
      const displayName = author.displayName || handle || did || "someone";
      const avatarURL = await fetchAvatarDataUri(author.did || "");

      return {
        type: "collection",
        author: authorName,
        displayName,
        avatarURL,
        text: "",
        quote: "",
        source: "",
        title: item.name || "Collection",
        icon: item.icon || "",
        description: item.description || "",
        color: "",
      };
    }
  } catch {
    /* fall through */
  }

  return null;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "\u2026";
}

function clean(v: string | undefined | null): string {
  return v && v !== "null" && v !== "undefined" ? v : "";
}

function extractBody(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object" && body !== null && "value" in body) {
    return String((body as { value: unknown }).value || "");
  }
  return "";
}

const C = {
  bg: "#18181b",
  bgCard: "#27272a",
  text: "#fafafa",
  textSecondary: "#a1a1aa",
  textMuted: "#71717a",
  textFaint: "#3f3f46",
  border: "#3f3f46",
};

const typeAccent: Record<string, string> = {
  annotation: "#3b82f6",
  highlight: "#facc15",
  bookmark: "#22c55e",
  collection: "#a78bfa",
};

const typeLabels: Record<string, string> = {
  annotation: "Annotation",
  highlight: "Highlight",
  bookmark: "Bookmark",
  collection: "Collection",
};

const namedColors: Record<string, string> = {
  yellow: "#facc15",
  green: "#4ade80",
  red: "#f87171",
  blue: "#60a5fa",
  purple: "#a78bfa",
  pink: "#f472b6",
  orange: "#fb923c",
};

function resolveHighlightColor(color: string): string {
  if (!color) return "#facc15";
  if (color.startsWith("#")) return color;
  return namedColors[color] || "#facc15";
}

function sanitizeColor(color: string): string {
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^rgba?\([0-9,.\s]+\)$/.test(color)) return color;
  return "#888888";
}

function coloredLogoUri(color: string): string {
  const safe = sanitizeColor(color);
  const publicDir = getPublicDir();
  const svg = readFileSync(join(publicDir, "logo.svg"), "utf-8");
  const recolored = svg.replace(/fill="[^"]*"/, `fill="${safe}"`);
  return `data:image/svg+xml,${encodeURIComponent(recolored)}`;
}

function logoElement(height: number, color: string): unknown | null {
  const uri = coloredLogoUri(color);
  if (!uri) return null;
  const width = Math.round(height * (265 / 231));
  return {
    type: "img",
    props: {
      src: uri,
      width,
      height,
      style: { flexShrink: 0, opacity: 0.9 },
    },
  };
}

const lucideFileMap: Record<string, string> = {
  file: "file-text",
  pin: "map-pin",
  trending: "trending-up",
};

function lucideIconUri(iconName: string, color: string): string | null {
  try {
    const safe = sanitizeColor(color);
    const fileName = lucideFileMap[iconName] || iconName;
    const iconPath = join(
      process.cwd(),
      "node_modules",
      "lucide-react",
      "dist",
      "esm",
      "icons",
      `${fileName}.js`,
    );
    const src = readFileSync(iconPath, "utf-8");
    const paths = [...src.matchAll(/d:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (!paths.length) return null;
    const pathEls = paths
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="${safe}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${pathEls}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

function avatarElement(url: string, name: string, size: number): unknown {
  if (url) {
    return {
      type: "img",
      props: {
        src: url,
        width: size,
        height: size,
        style: {
          borderRadius: size / 2,
          flexShrink: 0,
          border: `2px solid ${C.border}`,
        },
      },
    };
  }
  const letter =
    name[0] === "@"
      ? (name[1] || "?").toUpperCase()
      : (name[0] || "?").toUpperCase();
  return {
    type: "div",
    props: {
      style: {
        width: size,
        height: size,
        borderRadius: size / 2,
        background: C.bgCard,
        border: `2px solid ${C.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: C.textMuted,
        fontSize: Math.round(size * 0.45),
        fontWeight: 700,
        flexShrink: 0,
      },
      children: letter,
    },
  };
}

function accentBar(color: string): unknown {
  return {
    type: "div",
    props: {
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 5,
        background: color,
        borderRadius: "3px 0 0 3px",
      },
    },
  };
}

function bgPattern(patternColor = "rgba(255,255,255,0.03)"): unknown {
  return {
    type: "div",
    props: {
      style: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundImage: `radial-gradient(circle at 1px 1px, ${patternColor} 1px, transparent 0)`,
        backgroundSize: "32px 32px",
      },
    },
  };
}

function header(data: RecordData, accentColor: string): unknown {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", width: "100%" },
      children: [
        avatarElement(data.avatarURL, data.displayName || data.author, 64),
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              marginLeft: 18,
              flex: 1,
            },
            children: [
              {
                type: "span",
                props: {
                  style: { color: C.text, fontSize: 28, fontWeight: 700 },
                  children: truncate(data.displayName || data.author, 30),
                },
              },
              {
                type: "span",
                props: {
                  style: {
                    color: C.textMuted,
                    fontSize: 20,
                    marginTop: 3,
                  },
                  children: data.author,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(255,255,255,0.06)",
              borderRadius: 24,
              padding: "8px 18px 8px 14px",
            },
            children: [
              logoElement(22, accentColor),
              {
                type: "span",
                props: {
                  style: {
                    color: accentColor,
                    fontSize: 18,
                    fontWeight: 600,
                    letterSpacing: 0.5,
                  },
                  children: typeLabels[data.type] || data.type,
                },
              },
            ].filter(Boolean) as unknown[],
          },
        },
      ],
    },
  };
}

function footerEl(source: string): unknown | null {
  if (!source) return null;
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        marginTop: "auto",
        paddingTop: 24,
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              width: 8,
              height: 8,
              borderRadius: 4,
              background: C.textFaint,
              marginRight: 12,
            },
          },
        },
        {
          type: "span",
          props: {
            style: { color: C.textMuted, fontSize: 20 },
            children: source,
          },
        },
      ],
    },
  };
}

function card(
  children: unknown[],
  accentColor: string,
  opts?: { bg?: string; patternColor?: string },
): unknown {
  const bg = opts?.bg ?? C.bg;
  const patternColor = opts?.patternColor ?? "rgba(255,255,255,0.03)";
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        background: bg,
        padding: 0,
        fontFamily: "Inter",
        position: "relative",
      },
      children: [
        bgPattern(patternColor),
        accentBar(accentColor),
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              width: "100%",
              height: "100%",
              padding: "48px 56px 48px 60px",
              position: "relative",
            },
            children,
          },
        },
      ],
    },
  };
}

function buildAnnotationImage(data: RecordData) {
  const accent = typeAccent.annotation;
  const children: unknown[] = [header(data, accent)];

  if (data.text) {
    const len = data.text.length;
    children.push({
      type: "div",
      props: {
        style: {
          color: C.text,
          fontSize: len > 200 ? 32 : len > 100 ? 38 : 46,
          fontWeight: 400,
          lineHeight: 1.5,
          marginTop: 36,
          overflow: "hidden",
        },
        children: truncate(data.text, 240),
      },
    });
  }

  if (data.quote) {
    children.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          marginTop: 28,
          background: "rgba(59, 130, 246, 0.06)",
          borderRadius: 14,
          padding: "20px 24px",
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                width: 4,
                borderRadius: 2,
                background: accent,
                flexShrink: 0,
                opacity: 0.7,
              },
            },
          },
          {
            type: "div",
            props: {
              style: {
                color: C.textSecondary,
                fontSize: 24,
                lineHeight: 1.6,
                paddingLeft: 18,
                fontStyle: "italic",
                overflow: "hidden",
              },
              children: truncate(data.quote, 180),
            },
          },
        ],
      },
    });
  }

  const f = footerEl(data.source);
  if (f) children.push(f);
  return card(children, accent);
}

function buildHighlightImage(data: RecordData) {
  const highlightColor = resolveHighlightColor(data.color);
  const quoteText = data.quote || data.text || "Highlighted passage";
  const len = quoteText.length;

  const children: unknown[] = [
    header(data, highlightColor),
    {
      type: "div",
      props: {
        style: {
          color: highlightColor,
          fontSize: 120,
          fontWeight: 700,
          lineHeight: 1,
          marginTop: 28,
          opacity: 0.5,
        },
        children: "\u201C",
      },
    },
    {
      type: "div",
      props: {
        style: {
          color: C.text,
          fontSize: len > 150 ? 32 : len > 80 ? 40 : 50,
          fontWeight: 600,
          lineHeight: 1.4,
          marginTop: -28,
          overflow: "hidden",
        },
        children: truncate(quoteText, 200),
      },
    },
  ];

  if (data.text && data.quote) {
    children.push({
      type: "div",
      props: {
        style: { color: C.textMuted, fontSize: 22, marginTop: 22 },
        children: truncate(data.text, 80),
      },
    });
  }

  const f = footerEl(data.source);
  if (f) children.push(f);
  return card(children, highlightColor);
}

function buildBookmarkImage(data: RecordData) {
  const accent = typeAccent.bookmark;
  const children: unknown[] = [header(data, accent)];

  if (data.source) {
    children.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          alignItems: "center",
          marginTop: 36,
          gap: 10,
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                width: 10,
                height: 10,
                borderRadius: 5,
                background: accent,
                opacity: 0.6,
              },
            },
          },
          {
            type: "span",
            props: {
              style: { color: accent, fontSize: 22, fontWeight: 500 },
              children: data.source,
            },
          },
        ],
      },
    });
  }

  const titleLen = (data.text || "").length;
  children.push({
    type: "div",
    props: {
      style: {
        color: C.text,
        fontSize: titleLen > 60 ? 40 : 50,
        fontWeight: 700,
        lineHeight: 1.3,
        marginTop: data.source ? 14 : 36,
        overflow: "hidden",
      },
      children: truncate(data.text || "Untitled Bookmark", 80),
    },
  });

  if (data.quote) {
    children.push({
      type: "div",
      props: {
        style: {
          color: C.textSecondary,
          fontSize: 26,
          lineHeight: 1.5,
          marginTop: 18,
          overflow: "hidden",
        },
        children: truncate(data.quote, 160),
      },
    });
  }

  return card(children, accent);
}

function buildCollectionImage(data: RecordData) {
  const accent = typeAccent.collection;
  const children: unknown[] = [header(data, accent)];

  const iconChildren: unknown[] = [];
  if (data.icon) {
    if (data.icon.startsWith("icon:")) {
      const iconName = data.icon.replace("icon:", "");
      const uri = lucideIconUri(iconName, accent);
      if (uri) {
        iconChildren.push({
          type: "img",
          props: {
            src: uri,
            width: 64,
            height: 64,
            style: { flexShrink: 0 },
          },
        });
      }
    } else {
      iconChildren.push({
        type: "span",
        props: {
          style: { fontSize: 72, lineHeight: 1 },
          children: data.icon,
        },
      });
    }
  }
  iconChildren.push({
    type: "span",
    props: {
      style: {
        color: C.text,
        fontSize: (data.title || "").length > 24 ? 44 : 56,
        fontWeight: 700,
        overflow: "hidden",
        lineHeight: 1.2,
      },
      children: truncate(data.title || "Collection", 36),
    },
  });

  children.push({
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 24,
        marginTop: 40,
      },
      children: iconChildren,
    },
  });

  children.push({
    type: "div",
    props: {
      style: {
        color: data.description ? C.textSecondary : C.textMuted,
        fontSize: 28,
        lineHeight: 1.5,
        marginTop: 22,
        overflow: "hidden",
      },
      children: data.description
        ? truncate(data.description, 160)
        : "A collection on Margin",
    },
  });

  children.push({
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: "auto",
        paddingTop: 24,
      },
      children: [
        logoElement(24, C.textFaint),
        {
          type: "span",
          props: {
            style: { color: C.textFaint, fontSize: 20 },
            children: "margin.at",
          },
        },
      ].filter(Boolean) as unknown[],
    },
  });

  return card(children, accent);
}

function rrAvatar(
  url: string,
  name: string,
  size: number,
  pal: { border: string; accentTint: string; accentText: string },
): unknown {
  if (url) {
    return {
      type: "img",
      props: {
        src: url,
        width: size,
        height: size,
        style: {
          borderRadius: size / 2,
          flexShrink: 0,
          border: `2px solid ${pal.border}`,
        },
      },
    };
  }
  const letter = (
    name[0] === "@" ? name[1] || "?" : name[0] || "?"
  ).toUpperCase();
  return {
    type: "div",
    props: {
      style: {
        width: size,
        height: size,
        borderRadius: size / 2,
        background: pal.accentTint,
        border: `2px solid ${pal.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: pal.accentText,
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        flexShrink: 0,
      },
      children: letter,
    },
  };
}

function roomCornerUrl(rr: { customDomain?: string }, handle: string): string {
  const cd = clean(rr.customDomain);
  if (cd) return cd;
  let host = "margin.at";
  try {
    host = new URL(process.env.BASE_URL || "https://margin.at").hostname;
  } catch {
    /* keep default */
  }
  return `${host}/reading-room/${handle}`;
}

function buildReadingRoomImage(
  rr: {
    title?: string;
    subtitle?: string;
    description?: string;
    displayName?: string;
    handle?: string;
    avatar?: string;
    customDomain?: string;
    theme?: { accentColor?: string; backgroundColor?: string };
    featured?: unknown[];
    recent?: unknown[];
  },
  handle: string,
): unknown {
  const pal = buildPalette(
    rr.theme?.backgroundColor || "#fcfcfc",
    rr.theme?.accentColor || "#3b82f6",
  );
  const accent = sanitizeColor(pal.accent);
  const title =
    clean(rr.title) || `${clean(rr.displayName) || handle}'s Reading Room`;
  const subtitle = clean(rr.subtitle) || clean(rr.description) || "";
  const name = rr.displayName || handle;

  const hero: unknown[] = [
    {
      type: "div",
      props: {
        style: {
          color: pal.ink,
          fontSize: title.length > 40 ? 54 : 72,
          fontWeight: 700,
          lineHeight: 1.08,
          letterSpacing: -0.025,
          textAlign: "center",
          maxWidth: 940,
          overflow: "hidden",
        },
        children: truncate(title, 70),
      },
    },
  ];

  if (subtitle) {
    hero.push({
      type: "div",
      props: {
        style: {
          color: pal.muted,
          fontSize: 29,
          lineHeight: 1.4,
          textAlign: "center",
          maxWidth: 760,
          marginTop: 26,
          overflow: "hidden",
        },
        children: truncate(subtitle, 130),
      },
    });
  }

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: pal.bg,
        padding: "76px 88px",
        fontFamily: "Inter",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
            },
            children: hero,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  },
                  children: [
                    rrAvatar(rr.avatar || "", name, 50, pal),
                    {
                      type: "span",
                      props: {
                        style: {
                          color: accent,
                          fontSize: 26,
                          fontWeight: 600,
                        },
                        children: `@${handle}`,
                      },
                    },
                  ],
                },
              },
              {
                type: "span",
                props: {
                  style: {
                    color: pal.muted,
                    fontSize: 23,
                  },
                  children: truncate(roomCornerUrl(rr, handle), 42),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function extractNote(note: {
  motivation?: string;
  color?: string;
  target?: { selector?: { exact?: string }; title?: string; source?: string };
  body?: { value?: string };
}): {
  kind: "highlight" | "bookmark" | "note";
  quote: string;
  body: string;
  title: string;
  domain: string;
  color: string;
} {
  const motivation = note?.motivation || "";
  const exact = note?.target?.selector?.exact || "";
  const title = note?.target?.title || "";
  const body = note?.body?.value || "";
  const source = note?.target?.source || "";
  const color = note?.color || "";
  let domain = "";
  try {
    domain = source ? new URL(source).hostname.replace(/^www\./, "") : "";
  } catch {
    /* ignore */
  }
  const kind =
    motivation === "highlighting"
      ? "highlight"
      : motivation === "bookmarking"
        ? "bookmark"
        : "note";
  return { kind, quote: exact, body, title, domain, color };
}

function buildReadingRoomNoteImage(
  payload: {
    displayName?: string;
    handle?: string;
    avatar?: string;
    customDomain?: string;
    roomTitle?: string;
    theme?: { accentColor?: string; backgroundColor?: string };
    note?: unknown;
  },
  handle: string,
  avatarDataUri: string,
): unknown {
  const pal = buildPalette(
    payload.theme?.backgroundColor || "#fcfcfc",
    payload.theme?.accentColor || "#3b82f6",
  );
  const accent = sanitizeColor(pal.accent);
  const name = payload.displayName || handle;
  const note = extractNote(
    (payload.note as Parameters<typeof extractNote>[0]) || {},
  );

  const iconName =
    note.kind === "highlight"
      ? "quote"
      : note.kind === "bookmark"
        ? "bookmark"
        : "message-square";
  const iconUri = lucideIconUri(iconName, pal.accentText);
  const typeLabel =
    note.kind === "highlight"
      ? "Highlight"
      : note.kind === "bookmark"
        ? "Bookmark"
        : "Note";

  const cardChildren: unknown[] = [];

  const chipChildren: unknown[] = [];
  if (iconUri) {
    chipChildren.push({
      type: "img",
      props: { src: iconUri, width: 18, height: 18 },
    });
  }
  chipChildren.push({
    type: "span",
    props: {
      style: { color: pal.accentText, fontSize: 22, fontWeight: 600 },
      children: typeLabel,
    },
  });
  const typeChip: unknown = {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: pal.accentTint,
        borderRadius: 24,
        padding: "10px 18px 10px 14px",
        flexShrink: 0,
      },
      children: chipChildren,
    },
  };

  if (note.kind === "bookmark") {
    const displayTitle = note.title || note.domain;
    if (displayTitle) {
      cardChildren.push({
        type: "div",
        props: {
          style: {
            color: pal.ink,
            fontSize: 42,
            fontWeight: 700,
            overflow: "hidden",
          },
          children: truncate(displayTitle, 80),
        },
      });
    }
  }

  const hlBg = sanitizeColor(highlightBg(note.color, "#ffffff"));
  const hlInk = highlightInk("#ffffff");
  const mark = (text: string, big: boolean, marginTop: number) => ({
    type: "div",
    props: {
      style: {
        alignSelf: "flex-start",
        background: hlBg,
        color: hlInk,
        fontSize: big ? 38 : 22,
        fontWeight: 500,
        lineHeight: 1.4,
        borderRadius: 6,
        padding: big ? "14px 18px" : "8px 12px",
        maxWidth: "100%",
        marginTop,
        overflow: "hidden",
      },
      children: truncate(text, 170),
    },
  });

  if (note.kind === "highlight") {
    if (note.quote) {
      const hlColor = sanitizeColor(resolveHighlightColor(note.color));
      cardChildren.push({
        type: "div",
        props: {
          style: {
            color: hlColor,
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 0.7,
          },
          children: "\u201C",
        },
      });
      cardChildren.push({
        type: "div",
        props: {
          style: {
            color: pal.ink,
            fontSize: 38,
            lineHeight: 1.4,
            fontStyle: "italic",
            marginTop: 6,
            overflow: "hidden",
          },
          children: truncate(note.quote, 170),
        },
      });
    }
  } else if (note.kind === "bookmark") {
    if (note.body) {
      cardChildren.push({
        type: "div",
        props: {
          style: {
            color: pal.ink,
            fontSize: 30,
            lineHeight: 1.45,
            marginTop: 20,
            overflow: "hidden",
          },
          children: truncate(note.body, 220),
        },
      });
    }
  } else {
    if (note.quote) cardChildren.push(mark(note.quote, false, 0));
    if (note.body) {
      cardChildren.push({
        type: "div",
        props: {
          style: {
            color: pal.ink,
            fontSize: 36,
            lineHeight: 1.4,
            marginTop: 18,
            overflow: "hidden",
          },
          children: truncate(note.body, 220),
        },
      });
    }
  }

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: pal.bg,
        padding: "64px 72px",
        fontFamily: "Inter",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  },
                  children: [
                    rrAvatar(avatarDataUri, name, 50, pal),
                    {
                      type: "span",
                      props: {
                        style: {
                          color: accent,
                          fontSize: 26,
                          fontWeight: 600,
                        },
                        children: `@${handle}`,
                      },
                    },
                  ],
                },
              },
              typeChip,
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                    maxWidth: 1000,
                    background: pal.card,
                    border: `1px solid ${pal.border}`,
                    borderRadius: 16,
                    padding: "28px 36px",
                  },
                  children: cardChildren,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
            },
            children: [
              {
                type: "span",
                props: {
                  style: { color: pal.muted, fontSize: 22 },
                  children: note.domain || "",
                },
              },
              {
                type: "span",
                props: {
                  style: { color: pal.muted, fontSize: 22 },
                  children: truncate(roomCornerUrl(payload, handle), 42),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export const GET: APIRoute = async ({ url }) => {
  const uri = url.searchParams.get("uri");
  const readingRoomHandle = url.searchParams.get("readingRoom");

  if (!uri && !readingRoomHandle) {
    return new Response("uri or readingRoom parameter required", {
      status: 400,
    });
  }

  try {
    const fonts = loadFonts();
    let element: unknown;

    if (readingRoomHandle && uri) {
      const noteRes = await fetch(
        `${API_URL}/api/reading-room/${readingRoomHandle}/note?uri=${encodeURIComponent(uri)}`,
      );
      if (!noteRes.ok) {
        return new Response("Note not found", { status: 404 });
      }
      const payload = await noteRes.json();
      const avatarDataUri = await fetchAvatarDataUri(payload.did || "");
      element = buildReadingRoomNoteImage(
        payload,
        payload.handle || readingRoomHandle,
        avatarDataUri,
      );
    } else if (readingRoomHandle) {
      const rrRes = await fetch(
        `${API_URL}/api/reading-room/${readingRoomHandle}`,
      );
      if (!rrRes.ok) {
        return new Response("Reading room not found", { status: 404 });
      }
      const rr = await rrRes.json();
      rr.avatar = await fetchAvatarDataUri(rr.did || "");
      element = buildReadingRoomImage(rr, rr.handle || readingRoomHandle);
    } else {
      const data = await fetchRecordData(uri!);
      if (!data) {
        return new Response("Record not found", { status: 404 });
      }
      switch (data.type) {
        case "collection":
          element = buildCollectionImage(data);
          break;
        case "bookmark":
          element = buildBookmarkImage(data);
          break;
        case "highlight":
          element = buildHighlightImage(data);
          break;
        case "annotation":
        default:
          element = buildAnnotationImage(data);
          break;
      }
    }

    const svg = await satori(element as React.ReactNode, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: fonts.regular, weight: 400, style: "normal" },
        { name: "Inter", data: fonts.bold, weight: 700, style: "normal" },
      ],
      loadAdditionalAsset: async (code: string, segment: string) => {
        if (code === "emoji") {
          const codepoints = [...segment]
            .map((c) => c.codePointAt(0)!.toString(16))
            .join("-");
          const emojiUrl = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${codepoints}.svg`;
          try {
            const res = await fetch(emojiUrl);
            if (res.ok)
              return `data:image/svg+xml,${encodeURIComponent(await res.text())}`;
          } catch {
            // ignore
          }
          return "";
        }
        return loadFallbackFonts(code, segment);
      },
    });

    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 1200 },
    });
    const png = resvg.render().asPng();

    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    console.error("[og-image] Error generating image:", e);
    console.error("[og-image] cwd:", process.cwd());
    console.error("[og-image] publicDir:", getPublicDir());
    const BASE_URL = process.env.BASE_URL || "https://margin.at";
    return Response.redirect(`${BASE_URL}/og.png`, 302);
  }
};
