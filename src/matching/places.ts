import { normalizeText } from "../ingestion/normalize.js";

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

const MIN_CORRIDOR_KM = 15;
const CORRIDOR_WIDTH_RATIO = 0.35;
const END_SLACK_KM = 5;

/** Israeli cities with their spellings as job sites write them, in English transliterations and Hebrew. */
const ISRAELI_CITIES: [name: string, lat: number, lon: number, aliases: string[]][] = [
  ["tel aviv", 32.085, 34.781, ["tel aviv yafo", "tel aviv jaffa", "tlv", "jaffa", "yafo", "תל אביב", "יפו"]],
  ["jerusalem", 31.768, 35.214, ["ירושלים"]],
  ["haifa", 32.794, 34.99, ["חיפה"]],
  ["herzliya", 32.166, 34.844, ["herzliyya", "herzlia", "hertzliya", "herzeliya", "הרצליה"]],
  ["raanana", 32.184, 34.871, ["ra anana", "רעננה"]],
  ["petah tikva", 32.087, 34.887, ["petach tikva", "petah tikvah", "petach tikvah", "petah tiqwa", "petah tiqva", "פתח תקווה", "פתח תקוה"]],
  ["ramat gan", 32.068, 34.824, ["רמת גן"]],
  ["givatayim", 32.072, 34.811, ["givataim", "גבעתיים"]],
  ["bnei brak", 32.081, 34.833, ["bene beraq", "bnei berak", "בני ברק"]],
  ["holon", 32.011, 34.774, ["חולון"]],
  ["bat yam", 32.023, 34.751, ["בת ים"]],
  ["rishon lezion", 31.964, 34.804, ["rishon letsiyon", "rishon le zion", "rishon lezyon", "rishon letzion", "ראשון לציון"]],
  ["rehovot", 31.894, 34.811, ["rechovot", "rehovoth", "רחובות"]],
  ["ness ziona", 31.93, 34.799, ["nes ziona", "ness tziona", "nes tsiyona", "nes ziyyona", "נס ציונה"]],
  ["yavne", 31.878, 34.739, ["yavneh", "יבנה"]],
  ["netanya", 32.329, 34.857, ["natanya", "נתניה"]],
  ["kfar saba", 32.178, 34.907, ["kfar sava", "kefar sava", "כפר סבא"]],
  ["hod hasharon", 32.15, 34.888, ["הוד השרון"]],
  ["ramat hasharon", 32.146, 34.84, ["רמת השרון"]],
  ["rosh haayin", 32.096, 34.957, ["rosh ha ayin", "ראש העין"]],
  ["or yehuda", 32.031, 34.857, ["אור יהודה"]],
  ["yehud", 32.033, 34.888, ["yehud monosson", "יהוד"]],
  ["airport city", 31.99, 34.88, ["איירפורט סיטי"]],
  ["kiryat ono", 32.064, 34.856, ["qiryat ono", "קרית אונו", "קריית אונו"]],
  ["givat shmuel", 32.077, 34.849, ["גבעת שמואל"]],
  ["shoham", 31.999, 34.946, ["שוהם"]],
  ["elad", 32.052, 34.951, ["אלעד"]],
  ["modiin", 31.898, 35.01, ["modi in", "מודיעין"]],
  ["lod", 31.951, 34.889, ["lydda", "לוד"]],
  ["ramla", 31.929, 34.873, ["ramle", "רמלה"]],
  ["mazkeret batya", 31.854, 34.846, ["מזכרת בתיה"]],
  ["even yehuda", 32.27, 34.888, ["אבן יהודה"]],
  ["kadima", 32.276, 34.913, ["kadima zoran", "קדימה"]],
  ["kfar yona", 32.317, 34.935, ["kefar yona", "כפר יונה"]],
  ["tira", 32.234, 34.95, ["טירה"]],
  ["taibe", 32.266, 35.009, ["tayibe", "טייבה"]],
  ["hadera", 32.434, 34.919, ["חדרה"]],
  ["pardes hanna", 32.476, 34.973, ["pardes hana", "פרדס חנה"]],
  ["or akiva", 32.508, 34.919, ["אור עקיבא"]],
  ["caesarea", 32.5, 34.892, ["qesarya", "keisarya", "kesaria", "קיסריה"]],
  ["zichron yaakov", 32.572, 34.952, ["zikhron yaakov", "zikhron ya akov", "זכרון יעקב"]],
  ["yokneam", 32.659, 35.105, ["yoqneam", "יקנעם"]],
  ["tirat carmel", 32.761, 34.972, ["טירת כרמל"]],
  ["nesher", 32.766, 35.044, ["נשר"]],
  ["kiryat ata", 32.811, 35.106, ["qiryat ata", "קרית אתא", "קריית אתא"]],
  ["kiryat bialik", 32.837, 35.087, ["קרית ביאליק", "קריית ביאליק"]],
  ["kiryat motzkin", 32.836, 35.077, ["קרית מוצקין", "קריית מוצקין"]],
  ["acre", 32.928, 35.076, ["akko", "acco", "עכו"]],
  ["nahariya", 33.006, 35.094, ["nahariyya", "נהריה"]],
  ["karmiel", 32.919, 35.296, ["carmiel", "כרמיאל"]],
  ["nazareth", 32.699, 35.304, ["natzrat", "נצרת"]],
  ["migdal haemek", 32.676, 35.24, ["migdal ha emek", "מגדל העמק"]],
  ["afula", 32.607, 35.289, ["עפולה"]],
  ["tiberias", 32.795, 35.531, ["tveria", "טבריה"]],
  ["rosh pina", 32.969, 35.542, ["rosh pinna", "ראש פינה"]],
  ["kiryat shmona", 33.207, 35.57, ["qiryat shemona", "kiryat shemona", "קרית שמונה", "קריית שמונה"]],
  ["ariel", 32.106, 35.17, ["אריאל"]],
  ["beit shemesh", 31.747, 34.988, ["bet shemesh", "בית שמש"]],
  ["mevaseret zion", 31.802, 35.15, ["מבשרת ציון"]],
  ["maale adumim", 31.777, 35.298, ["ma ale adumim", "מעלה אדומים"]],
  ["gedera", 31.814, 34.777, ["גדרה"]],
  ["ashdod", 31.804, 34.655, ["אשדוד"]],
  ["kiryat malakhi", 31.731, 34.746, ["qiryat mal akhi", "קרית מלאכי", "קריית מלאכי"]],
  ["ashkelon", 31.669, 34.571, ["ashqelon", "אשקלון"]],
  ["kiryat gat", 31.61, 34.764, ["qiryat gat", "קרית גת", "קריית גת"]],
  ["sderot", 31.525, 34.596, ["שדרות"]],
  ["netivot", 31.421, 34.588, ["נתיבות"]],
  ["ofakim", 31.314, 34.62, ["אופקים"]],
  ["beer sheva", 31.252, 34.791, ["be er sheva", "beersheba", "beer sheba", "beersheva", "באר שבע"]],
  ["dimona", 31.069, 35.033, ["דימונה"]],
  ["eilat", 29.558, 34.952, ["elat", "אילת"]],
];

const PLACES = new Map<string, Place>();
const ALIASES: [alias: string, place: Place][] = [];
for (const [name, lat, lon, aliases] of ISRAELI_CITIES) {
  const place = { name, lat, lon };
  PLACES.set(name, place);
  for (const alias of new Set([name, ...aliases].map(normalizeText))) ALIASES.push([alias, place]);
}

export const ISRAELI_CITY_NAMES: readonly string[] = [...PLACES.keys()];

/** Words that only name a place, such as "tel" and "aviv", so they never count as career vocabulary. */
export const PLACE_WORDS: ReadonlySet<string> = new Set([
  "israel",
  "ישראל",
  ...ALIASES.flatMap(([alias]) => alias.split(" ")),
]);

/** The known city a place name refers to, in any spelling. */
export function findPlace(name: string): Place | null {
  const text = normalizeText(name);
  return ALIASES.find(([alias]) => alias === text)?.[1] ?? placesIn(name)[0] ?? null;
}

/** Every known city a free-text location mentions, e.g. "Bat Yam, Givatayim, Or Yehuda". */
export function placesIn(location: string): Place[] {
  const text = ` ${normalizeText(location)} `;
  const found = new Set<Place>();
  for (const [alias, place] of ALIASES) if (text.includes(` ${alias} `)) found.add(place);
  return [...found];
}

/**
 * Whether `place` lies between `from` and `to`: within a corridor along the line joining them, about a third as wide as
 * it is long (at least 15 km), extending a few km past either end.
 */
export function isBetween(from: Place, to: Place, place: Place): boolean {
  const lat0 = (from.lat + to.lat) / 2;
  const km = (p: Place) => ({ x: p.lon * 111.32 * Math.cos((lat0 * Math.PI) / 180), y: p.lat * 110.57 });
  const a = km(from);
  const b = km(to);
  const p = km(place);
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const ap = { x: p.x - a.x, y: p.y - a.y };
  const length = Math.hypot(ab.x, ab.y);
  if (length === 0) return Math.hypot(ap.x, ap.y) <= MIN_CORRIDOR_KM;
  const along = (ap.x * ab.x + ap.y * ab.y) / length;
  const across = Math.abs(ap.x * ab.y - ap.y * ab.x) / length;
  return (
    along >= -END_SLACK_KM &&
    along <= length + END_SLACK_KM &&
    across <= Math.max(MIN_CORRIDOR_KM, CORRIDOR_WIDTH_RATIO * length)
  );
}
