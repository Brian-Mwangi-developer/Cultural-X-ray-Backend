/**
 * What the assistant knows about the product itself (plan-guide.md §5): a short index it sees every
 * turn, and a card per page it reads only when it needs one. Parts are the `data-guide` names in the
 * web (web/src/lib/guide.ts ANCHORS); tests/guide-cards.test.ts fails if the two drift apart.
 */

export type Part = { id: string; what: string };
export type Card = {
  /** Path inside the workspace ("" is the overview). Null for pages that need an id (one ad's read). */
  path: string | null;
  title: string;
  what: string;
  parts: Part[];
  how: string[];
  /** What people get wrong here, said plainly. */
  confusions: string[];
  /** The walk-through that teaches this page, if any. */
  journey: string | null;
};

export const CARDS: Record<string, Card> = {
  overview: {
    path: "",
    title: "Overview",
    what: "The brand at a glance: X-Ray's read of the Culture Map, where the culture lives on a globe, what customers listen to, watch, follow and visit, and three plays.",
    parts: [{ id: "overview.read", what: "X-Ray's read: a few sentences on the map, the items it rests on, and the play to start with." }],
    how: ["Start with the read, then See the plays.", "Ask X-Ray about this asks the assistant what to do first."],
    confusions: ["While the map is building the overview shows its progress instead; it takes about a minute."],
    journey: null,
  },
  map: {
    path: "map",
    title: "Culture Map",
    what: "What the brand's customers like in eight categories, sorted into three columns: only theirs, shared with a rival, only a rival's.",
    parts: [
      { id: "map.compare", what: "The rivals it is compared with, and Change who you compare with (rebuilds the map)." },
      { id: "map.read", what: "One sentence on the category in the tab." },
      { id: "map.tabs", what: "Categories: podcasts, films, TV, creators, artists, places, brands, books." },
      { id: "map.filters", what: "Age band and Reach (mainstream or niche). A new view is read from Qloo once (a few queries), then kept." },
      { id: "map.yours", what: "Yours: only this brand's customers rank these. Easiest places to stand out." },
      { id: "map.shared", what: "Shared: both rank it; the bar says whose list it sits higher on. Hover for the sentence, click a row for the Qloo lists." },
      { id: "map.theirs", what: "Theirs: only a rival's customers rank it." },
    ],
    how: ["To see an age group: pick it in Age.", "To change rivals or add brands to read through: Change who you compare with.", "Rebuild asks Qloo again for everything (about 24 queries)."],
    confusions: [
      "Ranks are positions on each brand's top 20 list from Qloo, not sales.",
      "For a brand Qloo doesn't know yet, the map reads brands like it (read through) and the first column is Open to you.",
    ],
    journey: "map",
  },
  audience: {
    path: "audience",
    title: "Audience & places",
    what: "Who each brand reaches (age groups, women and men, in words) and the places its customers pick.",
    parts: [
      { id: "audience.read", what: "A sentence on who the customers are." },
      { id: "audience.globe", what: "Where the culture lives: towns on a globe; Open map shows every place." },
      { id: "audience.who", what: "Who they are, for the brand and each rival, as strong / weak." },
      { id: "audience.places", what: "Places customers pick, ranked, with who else has each one." },
    ],
    how: ["Use places for pop-ups, events and where to advertise."],
    confusions: ["Thin data means Qloo knows little about that group; it says so rather than guessing."],
    journey: null,
  },
  plays: {
    path: "plays",
    title: "Plays",
    what: "Moves the Culture Map backs: sponsor a podcast, work with a creator, show up at a place, hold shared ground. Each says why and what it rests on.",
    parts: [
      { id: "plays.first", what: "The lead play, with one line on why." },
      { id: "plays.source", what: "The map item the play rests on; hover for where it ranks for the brand and rivals." },
    ],
    how: ["Open play shows who to work with (their real channels) and a first message.", "Refresh plays writes them again from the latest map."],
    confusions: ["Plays are rewritten when the map is rebuilt or the compare set changes."],
    journey: "plays",
  },
  "ad-check": {
    path: "ad-check",
    title: "Ad check",
    what: "Upload a draft video (up to 60 seconds) to see whose culture it speaks to and what to fix before spending on it.",
    parts: [
      { id: "adcheck.upload", what: "Drop a video or Choose a video; then pick where it will run (TikTok, Reels, YouTube…)." },
      { id: "adcheck.list", what: "Ads already checked, with what each leans to." },
    ],
    how: ["Reading takes about two minutes and uses model credit, not Qloo queries.", "Channels change what's checked: shape (9:16 for TikTok and Reels), first seconds, sound."],
    confusions: ["Nothing is posted anywhere; the video can be deleted after reading."],
    journey: "ad",
  },
  "ad-read": {
    path: null,
    title: "An ad's read",
    what: "One checked ad: the video, whether it sells what the business sells, whose culture it speaks to, and what to fix before it runs.",
    parts: [
      { id: "adcheck.video", what: "The ad, with shots; findings jump to their moment." },
      { id: "adcheck.fit", what: "Shown when the ad doesn't show what the business sells; offers a reshoot brief." },
      { id: "adcheck.read", what: "X-Ray's read of the ad in the map's words: towards the brand's customers or a rival's." },
      { id: "adcheck.before", what: "Before it runs: shape, first seconds, sound and a next step, each with evidence." },
    ],
    how: ["Suggested re-cuts are written from the same footage; they're off when the ad shows the wrong product."],
    confusions: [],
    journey: "ad-read",
  },
  sidebar: {
    path: null,
    title: "Sidebar (every page)",
    what: "Pages, Compared with (rivals and read-through brands, + adds more), and the Qloo queries meter.",
    parts: [
      { id: "sidebar.compare", what: "Rivals and brands the culture is read through; + opens Change who you compare with." },
      { id: "sidebar.usage", what: "Qloo queries used this month against the allowance; cached answers are free." },
    ],
    how: ["Settings (bottom left): members, agencies, billing, usage, profile."],
    confusions: [],
    journey: null,
  },
};

export const JOURNEY_IDS = ["map", "plays", "ad", "ad-read"] as const;

/** Where a part lives, for pointing at it from another page. */
export function cardOfPart(part: string): [string, Card] | null {
  for (const entry of Object.entries(CARDS)) if (entry[1].parts.some((p) => p.id === part)) return entry;
  return null;
}

/** The index the assistant sees every turn: one line per page. */
export const PRODUCT_INDEX = Object.entries(CARDS)
  .map(([id, c]) => `- ${id}${c.path !== null ? ` (/${c.path})` : ""}: ${c.what}`)
  .join("\n");
