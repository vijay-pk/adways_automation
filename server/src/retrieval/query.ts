const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at by for with from about into over after before is are was were be been
  being do does did doing have has had i me my we our you your he she it its they them their this that these those what which
  who whom how why when where can could should would will shall may might must please explain tell give show example examples
  simple simply words word more another again thanks thank hi hello hey ok okay understand dont don't not no yes just also
  instructor class course lesson said say says mean means meaning`.split(/\s+/),
);

/** Common performance-marketing abbreviations, expanded for transcript search. */
const EXPANSIONS: Record<string, string> = {
  ctr: 'click through rate',
  cpc: 'cost per click',
  cpm: 'cost per mille',
  cpa: 'cost per acquisition',
  cpl: 'cost per lead',
  cvr: 'conversion rate',
  roas: 'return on ad spend',
  roi: 'return on investment',
  ltv: 'lifetime value',
  clv: 'customer lifetime value',
  aov: 'average order value',
  kpi: 'key performance indicator',
  seo: 'search engine optimization',
  sem: 'search engine marketing',
  ppc: 'pay per click',
  utm: 'utm parameters tracking',
  pixel: 'pixel tracking',
  capi: 'conversions api',
};

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/@\S+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

const sanitize = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Builds an OR-combined to_tsquery string from the question and search terms.
 * Multi-word terms become AND groups; abbreviations are expanded.
 */
export function buildTsQuery(question: string, searchTerms: string[] = []): string | null {
  const groups = new Set<string>();
  const addTerm = (term: string) => {
    const words = term.split(/\s+/).map(sanitize).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    if (!words.length) return;
    groups.add(words.length === 1 ? words[0] : `(${words.join(' & ')})`);
  };
  for (const kw of extractKeywords(question)) {
    addTerm(kw);
    if (EXPANSIONS[kw]) addTerm(EXPANSIONS[kw]);
  }
  for (const t of searchTerms) {
    addTerm(t);
    const k = sanitize(t);
    if (EXPANSIONS[k]) addTerm(EXPANSIONS[k]);
  }
  if (!groups.size) return null;
  return [...groups].slice(0, 24).join(' | ');
}

/** Normalised key used to detect examples that answer the same question. */
export function questionKey(q: string): string {
  return extractKeywords(q)
    .map((w) => EXPANSIONS[w] ?? w)
    .join(' ')
    .split(' ')
    .filter((w) => !STOPWORDS.has(w))
    .sort()
    .join(' ');
}
