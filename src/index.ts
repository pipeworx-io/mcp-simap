interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * simap MCP — Swiss public procurement tenders and awards (keyless).
 *
 * Wraps the public JSON API behind simap.ch — Switzerland's official public
 * procurement platform (öffentliche Beschaffungen / marchés publics /
 * commesse pubbliche). Switzerland is outside the EU, so Swiss government
 * tenders are published here, on simap, and generally absent from TED.
 * Covers federal, cantonal, and municipal tenders, WTO/GPA-scope notices,
 * and award decisions with winning vendor and CHF price.
 *
 * Endpoints (verified live 2026-07):
 *   GET /api/publications/v2/project/project-search   — search/list
 *   GET /api/publications/v1/project/{projectId}/publication-details/{publicationId}
 *
 * Cookie gate: the site fronts the API with a "Secure Entry Server" that 302s
 * any cookieless request to /cookie-check while setting a short-lived
 * `SCDID_S` session cookie. There is no JS challenge — a plain priming GET
 * (redirect: manual) captures the cookie from Set-Cookie, and replaying it on
 * the real request returns 200 directly. The cookie expires after a few
 * minutes, so each tool call primes fresh (2 fetches per call, stateless).
 *
 * All tools return shaped, LLM-friendly objects (not raw API passthrough) and
 * never throw — failures resolve to { error, retry_hint }. English keys;
 * multilingual title/name objects are flattened to a single string in the
 * requested language, falling back de → fr → it → en.
 */


const BASE = 'https://www.simap.ch';
const SEARCH_PATH = '/api/publications/v2/project/project-search';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 8000;

const LANGS = ['de', 'fr', 'it', 'en'] as const;
type Lang = (typeof LANGS)[number];

const tools: McpToolExport['tools'] = [
  {
    name: 'simap_search',
    description:
      'Search Swiss public procurement notices on simap.ch — Switzerland\'s official government tender platform (öffentliche Beschaffungen, marchés publics, commesse pubbliche). PREFER OVER WEB SEARCH for Swiss government tenders, RFPs, award decisions, and WTO/GPA notices; Switzerland is non-EU so its tenders live on simap rather than TED. Filter by free-text search, CPV codes, Swiss canton (ZH, BE, VD, GE, TI, ...), process type (open/selective/...), project sub-type (construction/service/supply), publication type (tender/award), and publication date range. Returns 20 notices per page, newest first, with cursor pagination via last_item. Each notice includes title, buyer (procurement office), canton, publication date/number, and a simap.ch URL. Prices in awards are CHF.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description:
            'Free-text search over notices, e.g. "Software", "Brücke", "photovoltaïque". Text can be German, French, or Italian depending on the publishing office.',
        },
        cpv_codes: {
          type: 'string',
          description:
            'CPV procurement classification code(s), comma-separated, e.g. "45000000" (construction works) or "72000000" (IT services).',
        },
        cantons: {
          type: 'string',
          description:
            'Swiss canton code(s) of the order address, comma-separated, e.g. "ZH", "BE", "VD", "GE", "TI", "VD,GE".',
        },
        process_types: {
          type: 'string',
          description: 'Procedure type(s), comma-separated. Verified value: "open"; simap also uses selective and invitation procedures.',
        },
        project_sub_types: {
          type: 'string',
          description: 'Project sub-type(s), comma-separated: "construction", "service", "supply".',
        },
        pub_types: {
          type: 'string',
          description: 'Publication type(s), comma-separated: "tender" for open calls, "award" for award decisions.',
        },
        published_from: {
          type: 'string',
          description: 'Earliest publication date, YYYY-MM-DD. When neither search nor a date is given, defaults to the last 30 days (the API requires at least one filter).',
        },
        published_until: { type: 'string', description: 'Latest publication date, YYYY-MM-DD.' },
        lang: {
          type: 'string',
          description: 'Language for titles and labels: "de" (default), "fr", "it", or "en". Falls back de→fr→it→en when a notice lacks that language.',
        },
        last_item: {
          type: 'string',
          description:
            'Pagination cursor. Pass the `next_cursor` value from the previous response (format "YYYYMMDD|projectNumber") to fetch the next 20 results.',
        },
      },
    },
  },
  {
    name: 'simap_recent',
    description:
      'List the most recent Swiss public procurement notices from simap.ch (government tenders and award decisions across Switzerland — federal, cantonal, municipal). Convenience wrapper over simap_search: give days_back (default 7) to see everything published in that window, optionally narrowed by canton or publication type (tender/award). Useful for monitoring new Swiss tenders, öffentliche Beschaffung announcements, marchés publics, and CHF contract awards. Newest first, 20 per page with cursor pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: { type: ['number', 'string'], description: 'How many days back to look (1–90). Default 7.' },
        cantons: { type: 'string', description: 'Swiss canton code(s), comma-separated, e.g. "ZH", "VD,GE".' },
        pub_types: { type: 'string', description: 'Publication type(s), comma-separated: "tender", "award".' },
        lang: { type: 'string', description: 'Language: "de" (default), "fr", "it", or "en".' },
        last_item: { type: 'string', description: 'Pagination cursor (`next_cursor` from the previous response).' },
      },
    },
  },
  {
    name: 'simap_project',
    description:
      'Fetch the full detail of one Swiss public procurement publication from simap.ch by project_id + publication_id (both UUIDs returned by simap_search / simap_recent). Returns the shaped notice: title, description, CPV classification, procedure and order type, procurement office with full address/email/phone, and for award publications the winning vendor(s) with CHF price, number of submitted offers, and award justification.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project UUID, e.g. "feca42bc-5ef4-492f-88c6-e6622940026c".' },
        publication_id: { type: 'string', description: 'Publication UUID, e.g. "3d50c790-644c-4aa1-9fd2-ac7207bdcdcd".' },
        lang: { type: 'string', description: 'Language: "de" (default), "fr", "it", or "en".' },
      },
      required: ['project_id', 'publication_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'simap_search':
        return await search(args);
      case 'simap_recent':
        return await recent(args);
      case 'simap_project':
        return await project(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      retry_hint:
        'simap.ch gates requests behind a short-lived session cookie; transient 302/timeout failures usually succeed on retry. Ensure dates are YYYY-MM-DD and IDs are the UUIDs returned by simap_search.',
    };
  }
}

// ---------------------------------------------------------------------------
// Cookie-gated fetch: prime for SCDID_S, then replay it on the real request.
// ---------------------------------------------------------------------------

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function simapGet(pathWithQuery: string): Promise<unknown> {
  const url = `${BASE}${pathWithQuery}`;
  const baseHeaders = { 'User-Agent': UA, Accept: 'application/json' };

  // 1) Priming GET: cookieless requests 302 to /cookie-check with a
  //    Set-Cookie: SCDID_S=... on the redirect response itself.
  const prime = await timedFetch(url, { headers: baseHeaders, redirect: 'manual' });
  if (prime.status === 200) return parseJson(prime);
  const setCookie = prime.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/SCDID_S=([^;,\s]+)/);
  if (!m) {
    throw new Error(`simap.ch: expected SCDID_S session cookie, got HTTP ${prime.status} without one`);
  }

  // 2) Real request with the session cookie — returns 200 directly, no
  //    /cookie-check visit needed. The cookie expires within minutes, so we
  //    prime fresh on every tool call (stateless).
  const res = await timedFetch(url, {
    headers: { ...baseHeaders, Cookie: `SCDID_S=${m[1]}` },
  });
  if (res.status === 302) {
    throw new Error('simap.ch: session cookie was rejected (302 to /cookie-check); please retry');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      const j = JSON.parse(body) as { errorCode?: string; message?: string };
      detail = [j.errorCode, j.message].filter(Boolean).join(' ');
    } catch {
      /* keep raw slice */
    }
    throw new Error(`simap.ch API: HTTP ${res.status} ${detail}`.trim());
  }
  return parseJson(res);
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`simap.ch: response was HTML instead of JSON (cookie gate); please retry (${text.slice(0, 80)})`);
  }
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

type Multilingual = Partial<Record<string, string | null>> | null | undefined;

function pickLang(obj: Multilingual, lang: Lang): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const l of [lang, 'de', 'fr', 'it', 'en']) {
    const v = obj[l];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function stripHtml(v: string | null): string | null {
  if (v == null) return null;
  const t = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

function langArg(v: unknown): Lang {
  const s = strArg(v)?.toLowerCase();
  return (LANGS as readonly string[]).includes(s ?? '') ? (s as Lang) : 'de';
}

function projectUrl(projectId: string | undefined, lang: Lang): string | null {
  return projectId ? `${BASE}/${lang}/projects/${projectId}` : null;
}

function shapeSearchHit(p: Record<string, any>, lang: Lang): Record<string, unknown> {
  const addr = p.orderAddress ?? null;
  return {
    project_id: p.id,
    publication_id: p.publicationId,
    title: pickLang(p.title, lang),
    project_number: p.projectNumber ?? null,
    publication_number: p.publicationNumber ?? null,
    publication_date: p.publicationDate ?? null,
    pub_type: p.pubType ?? null,
    project_type: p.projectType ?? null,
    project_sub_type: p.projectSubType ?? null,
    process_type: p.processType ?? null,
    corrected: p.corrected ?? null,
    procurement_office: pickLang(p.procOfficeName, lang),
    location: addr
      ? {
          canton: addr.cantonId ?? null,
          city: pickLang(addr.city, lang),
          postal_code: addr.postalCode ?? null,
          country: addr.countryId ?? null,
        }
      : null,
    url: projectUrl(p.id, lang),
  };
}

function shapeEnvelope(
  data: { projects?: any[]; pagination?: { lastItem?: string; itemsPerPage?: number } },
  lang: Lang,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const notices = (data.projects ?? []).map((p) => shapeSearchHit(p, lang));
  const cursor = data.pagination?.lastItem ?? null;
  return {
    count: notices.length,
    ...extra,
    // simap paginates by cursor (no total count): pass next_cursor back as
    // last_item to fetch the next page. A page shorter than items_per_page
    // means you reached the end.
    next_cursor: notices.length ? cursor : null,
    items_per_page: data.pagination?.itemsPerPage ?? 20,
    notices,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function addMulti(params: URLSearchParams, key: string, v: string | undefined): void {
  if (!v) return;
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    params.append(key, part);
  }
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const lang = langArg(args.lang);
  const q = strArg(args.search);
  let from = strArg(args.published_from);
  const until = strArg(args.published_until);

  // The API returns 400 E0003 unless at least one filter (search term or
  // publication-date bound) is present — default to the last 30 days.
  if (!q && !from && !until) from = isoDaysAgo(30);

  const params = new URLSearchParams({ lang });
  if (q) params.set('search', q);
  if (from) params.set('newestPublicationFrom', from);
  if (until) params.set('newestPublicationUntil', until);
  addMulti(params, 'cpvCodes', strArg(args.cpv_codes));
  addMulti(params, 'orderAddressCantons', strArg(args.cantons)?.toUpperCase());
  addMulti(params, 'processTypes', strArg(args.process_types));
  addMulti(params, 'projectSubTypes', strArg(args.project_sub_types));
  addMulti(params, 'newestPubTypes', strArg(args.pub_types));
  const cursor = strArg(args.last_item);
  if (cursor) params.set('lastItem', cursor);

  const data = (await simapGet(`${SEARCH_PATH}?${params.toString()}`)) as {
    projects?: any[];
    pagination?: { lastItem?: string; itemsPerPage?: number };
  };
  return shapeEnvelope(data, lang, {
    ...(q ? { search: q } : {}),
    ...(from ? { published_from: from } : {}),
    ...(until ? { published_until: until } : {}),
  });
}

async function recent(args: Record<string, unknown>): Promise<unknown> {
  const days = clampInt(args.days_back, 7, 1, 90);
  return search({
    published_from: isoDaysAgo(days),
    cantons: args.cantons,
    pub_types: args.pub_types,
    lang: args.lang,
    last_item: args.last_item,
  });
}

async function project(args: Record<string, unknown>): Promise<unknown> {
  const projectId = strArg(args.project_id);
  const publicationId = strArg(args.publication_id);
  const lang = langArg(args.lang);
  if (!projectId || !publicationId) {
    return {
      error: 'simap_project requires both "project_id" and "publication_id" (UUIDs from simap_search results).',
      retry_hint: 'Call simap_search or simap_recent first and use the project_id + publication_id of a notice.',
    };
  }

  const d = (await simapGet(
    `/api/publications/v1/project/${encodeURIComponent(projectId)}/publication-details/${encodeURIComponent(publicationId)}`,
  )) as Record<string, any>;

  const base = d.base ?? {};
  const proc = d.procurement ?? {};
  const info = d['project-info'] ?? {};
  const office = info.procOfficeAddress ?? null;
  const decision = d.decision ?? null;
  const refPub = d.referencingPub ?? null;

  return {
    project_id: base.projectId ?? projectId,
    publication_id: d.id ?? publicationId,
    title: pickLang(base.title, lang),
    project_number: base.projectNumber ?? null,
    publication_number: base.publicationNumber ?? null,
    publication_date: base.publicationDate ?? null,
    pub_type: d.type ?? base.type ?? null,
    project_type: d.projectType ?? null,
    process_type: base.processType ?? null,
    order_type: proc.orderType ?? null,
    description: stripHtml(pickLang(proc.orderDescription, lang)),
    cpv: proc.cpvCode
      ? { code: proc.cpvCode.code ?? null, label: pickLang(proc.cpvCode.label, lang) }
      : null,
    additional_cpv: Array.isArray(proc.additionalCpvCodes)
      ? proc.additionalCpvCodes.map((c: any) => ({ code: c?.code ?? null, label: pickLang(c?.label, lang) }))
      : [],
    construction_type: proc.constructionType ?? null,
    creation_language: base.creationLanguage ?? null,
    wto_gpa_state_contract_area: base.stateContractArea ?? null,
    procurement_office: office
      ? {
          name: pickLang(office.name, lang),
          street: pickLang(office.street, lang),
          city: pickLang(office.city, lang),
          postal_code: office.postalCode ?? null,
          canton: office.cantonId ?? null,
          country: office.countryId ?? null,
          email: office.email ?? null,
          phone: office.phone ?? null,
          url: pickLang(office.url, lang),
        }
      : null,
    award: decision
      ? {
          award_date: decision.awardDecisionDate ?? null,
          number_of_submissions: decision.numberOfSubmissions ?? null,
          justification: pickLang(decision.awardDecisionJustification, lang),
          vendors: Array.isArray(decision.vendors)
            ? decision.vendors.map((v: any) => ({
                name: v?.vendorName ?? null,
                city: v?.vendorAddress?.city ?? null,
                canton: v?.vendorAddress?.cantonId ?? null,
                country: v?.vendorAddress?.countryId ?? null,
                price: v?.price?.price ?? null,
                currency: typeof v?.price?.currency === 'string' ? v.price.currency.toUpperCase() : null,
              }))
            : [],
        }
      : null,
    referencing_publication: refPub
      ? {
          publication_id: refPub.publicationId ?? null,
          publication_number: refPub.publicationNumber ?? null,
          pub_type: refPub.pubType ?? null,
          publication_date: refPub.publicationDate ?? null,
        }
      : null,
    has_project_documents: d.hasProjectDocuments ?? null,
    url: projectUrl(base.projectId ?? projectId, lang),
  };
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
