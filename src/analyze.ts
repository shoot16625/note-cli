import type { NoteSummary } from "./normalize.ts";

export interface NumberStats {
  count: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
  min: number;
}

export function numberStats(values: number[]): NumberStats {
  if (values.length === 0) return { count: 0, mean: 0, median: 0, p90: 0, max: 0, min: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    mean: round(mean),
    median: q(0.5),
    p90: q(0.9),
    max: sorted[sorted.length - 1],
    min: sorted[0],
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Title features that commonly differ between high/low performing posts. */
const TITLE_FEATURES: Record<string, (t: string) => boolean> = {
  brackets: (t) => /[【】\[\]「」『』]/.test(t),
  number: (t) => /[0-9０-９]/.test(t),
  question: (t) => /[?？]/.test(t),
  exclamation: (t) => /[!！]/.test(t),
  separator: (t) => /[｜|:：/／]/.test(t),
};

export interface Analysis {
  sampleSize: number;
  likes: NumberStats;
  paid: { count: number; ratio: number; price: NumberStats; likesOfPaid: NumberStats; likesOfFree: NumberStats };
  titleLength: { stats: NumberStats; byBucket: Array<{ bucket: string; count: number; medianLikes: number }> };
  titleFeatures: Array<{ feature: string; withCount: number; medianLikesWith: number; medianLikesWithout: number }>;
  publishTime: {
    /** JST */
    byWeekday: Array<{ weekday: string; count: number; medianLikes: number }>;
    byHour: Array<{ hour: number; count: number; medianLikes: number }>;
    oldest: string | null;
    newest: string | null;
  };
  topAuthors: Array<{ urlname: string; nickname: string | null; count: number; totalLikes: number }>;
  topHashtags: Array<{ hashtag: string; count: number }>;
  topNotes: Array<Pick<NoteSummary, "title" | "url" | "likeCount" | "price" | "publishAt"> & { author: string | null }>;
}

export function analyzeNotes(notes: NoteSummary[], opts: { top?: number } = {}): Analysis {
  const top = opts.top ?? 10;
  const likes = (ns: NoteSummary[]) => ns.map((n) => n.likeCount);
  const paid = notes.filter((n) => n.isPaid);
  const free = notes.filter((n) => !n.isPaid);

  const buckets: Array<[string, number, number]> = [
    ["<20", 0, 20],
    ["20-29", 20, 30],
    ["30-39", 30, 40],
    ["40-49", 40, 50],
    ["50+", 50, Infinity],
  ];
  const titleLen = (n: NoteSummary) => [...n.title].length;

  const withTime = notes
    .filter((n) => n.publishAt)
    .map((n) => ({ n, jst: toJst(new Date(n.publishAt as string)) }))
    .filter((x) => !Number.isNaN(x.jst.getTime()));

  const authorMap = new Map<string, { nickname: string | null; count: number; totalLikes: number }>();
  for (const n of notes) {
    if (!n.author.urlname) continue;
    const a = authorMap.get(n.author.urlname) ?? { nickname: n.author.nickname, count: 0, totalLikes: 0 };
    a.count++;
    a.totalLikes += n.likeCount;
    authorMap.set(n.author.urlname, a);
  }

  const tagMap = new Map<string, number>();
  for (const n of notes) for (const t of n.hashtags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);

  const sortedTimes = withTime.map((x) => x.n.publishAt as string).sort();

  return {
    sampleSize: notes.length,
    likes: numberStats(likes(notes)),
    paid: {
      count: paid.length,
      ratio: notes.length ? round(paid.length / notes.length) : 0,
      price: numberStats(paid.map((n) => n.price)),
      likesOfPaid: numberStats(likes(paid)),
      likesOfFree: numberStats(likes(free)),
    },
    titleLength: {
      stats: numberStats(notes.map(titleLen)),
      byBucket: buckets.map(([bucket, lo, hi]) => {
        const ns = notes.filter((n) => titleLen(n) >= lo && titleLen(n) < hi);
        return { bucket, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      }),
    },
    titleFeatures: Object.entries(TITLE_FEATURES).map(([feature, test]) => {
      const withF = notes.filter((n) => test(n.title));
      const without = notes.filter((n) => !test(n.title));
      return {
        feature,
        withCount: withF.length,
        medianLikesWith: numberStats(likes(withF)).median,
        medianLikesWithout: numberStats(likes(without)).median,
      };
    }),
    publishTime: {
      byWeekday: WEEKDAYS.map((weekday, i) => {
        const ns = withTime.filter((x) => x.jst.getUTCDay() === i).map((x) => x.n);
        return { weekday, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      }),
      byHour: Array.from({ length: 24 }, (_, hour) => {
        const ns = withTime.filter((x) => x.jst.getUTCHours() === hour).map((x) => x.n);
        return { hour, count: ns.length, medianLikes: numberStats(likes(ns)).median };
      }).filter((h) => h.count > 0),
      oldest: sortedTimes[0] ?? null,
      newest: sortedTimes[sortedTimes.length - 1] ?? null,
    },
    topAuthors: [...authorMap.entries()]
      .map(([urlname, a]) => ({ urlname, ...a }))
      .sort((a, b) => b.count - a.count || b.totalLikes - a.totalLikes)
      .slice(0, top),
    topHashtags: [...tagMap.entries()]
      .map(([hashtag, count]) => ({ hashtag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top * 2),
    topNotes: [...notes]
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, top)
      .map((n) => ({
        title: n.title,
        url: n.url,
        likeCount: n.likeCount,
        price: n.price,
        publishAt: n.publishAt,
        author: n.author.urlname,
      })),
  };
}

/** Shift a Date so that its UTC fields read as JST wall-clock time. */
function toJst(d: Date): Date {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
