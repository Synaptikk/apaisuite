// modules/safetyobs/lib/parse.js
//
// One plain sentence → the survey's answers. Pure; tested in
// lib/tests/parse.test.mjs.
//
// Keyword rules, first match wins, so the more specific rules sit above the
// general ones ("climbing on a pallet" must land on Climbing, not Stocking;
// "spill station" on Spill station, not Cleaning supplies). Anything the
// rules had to default is listed in `guessed`, and anything they could not
// fill at all in `missing`, so the panel can ask instead of submitting a
// guess. When the AI gateway is available (service.js) its pick replaces the
// rule pick field by field, but only with a value from the form's own list.

import { LOCATIONS, PROCESSES, TOOLS, TYPES, shiftForHour } from "./form_schema.js";

const LOCATION_RULES = [
  [/\bparking lot\b|\bparking\b|\bcart corral\b|\blot\b/, "Parking Lot"],
  [/\bfuel\b|\bgas station\b|\bmurphy\b/, "Fuel Station"],
  [/\bvision( center)?\b|\boptical\b/, "Vision Center"],
  [/\bpharmacy\b|\brx\b/, "Pharmacy"],
  [/\baction alley\b/, "Action Alley"],
  [/\bacc\b|\bauto ?care\b|\btire\b|\bauto center\b|\boil change\b/, "ACC"],
  [/\bopd\b|\bdigital\b|\bpick ?up\b|\bstore fulfillment\b|\bdispense\b|\bpersonal shopper\b/, "Store Fulfillment"],
  [/\bfresh\b|\bproduce\b|\bmeat\b|\bdeli\b|\bbakery\b|\bdairy\b|\bfrozen\b/, "Fresh"],
  // Work areas outrank the merchandise's department: "grocery receiving" is
  // Backroom, not Food. Spelling tolerant (recieving, reciving).
  [/\bback ?room\b|\bre(c|s)(ei|ie|i)v(e|ed|ing)\b|\bdock\b|\btruck\b|\bunload(ing|ed)?\b|\bbaler\b|\bcompactor\b|\bsteel\b|\b(shrink|stretch) ?wrap/, "Backroom"],
  [/\bfront ?end\b|\bregisters?\b|\bcheck ?outs?\b|\bself[- ]checkout\b|\bcustomer service\b|\bvestibule\b|\bentrance\b|\bexit\b/, "Front End"],
  [/\bseasonal\b|\bgarden\b|\blawn\b|\bhalloween\b|\bchristmas\b|\bholiday\b/, "Seasonal"],
  [/\bentertainment\b|\belectronics\b|\btoys?\b|\bmedia\b/, "Entertainment"],
  [/\bfashion\b|\bapparel\b|\bclothing\b|\bfitting room\b|\bshoes\b|\bjewelry\b/, "Fashion"],
  [/\bhardlines\b|\bhardware\b|\bpaint\b|\bsporting\b|\bautomotive\b|\bsports\b/, "Hardlines"],
  [/\bhome\b|\bhousewares\b|\bbedding\b|\bbath\b|\bkitchen\b|\bfurniture\b|\bcrafts?\b/, "Home"],
  [/\bconsumables\b|\bchemicals?\b|\bpaper\b|\bpets?\b|\bhba\b|\bhealth (and|&) beauty\b|\bcosmetics\b|\bbaby\b|\bhousehold\b/, "Consumables"],
  [/\bfood\b|\bgrocery\b|\bdry grocery\b|\bsnacks?\b|\bdrinks?\b|\bsoda\b|\bbeverages?\b|\bcoke\b|\bpepsi\b|\bchips\b|\bbread\b/, "Food"],
];

const PROCESS_RULES = [
  [/\bclimb(ing|ed|s)?\b|\bstanding on\b|\bstood on\b|\bstand on\b/, "Climbing"],
  [/\bbox ?cutter\b|\bcut(ting|s)?\b|\bslic(e|ing)\b|\bknife\b|\bopening (a )?(box|case)/, "Cutting"],
  [/\bspill\b|\bclean(ing|ed|s)?\b|\bmop(ping|ped)?\b|\bsweep(ing)?\b|\bwip(e|ing)\b|\bsanitiz/, "Cleaning"],
  [/\bppe\b|\bgloves?\b|\bgoggles\b|\bsafety glasses\b|\bcut[- ]resistant\b|\bhard hat\b|\bsteel toe/, "PPE Usage"],
  [/\breach(ing|ed)?\b|\bstretch(ing|ed)?\b|\boverhead\b/, "Stretching"],
  [/\blift(ing|ed|s)?\b(?! ?(truck|gate))|\bcarr(y|ying|ied)\b|\bbend(ing)?\b|\btwist(ing)?\b|\bheavy\b/, "Lifting"],
  [/\bpallet ?jack\b|\bforklift\b|\bepj\b|\bstocker\b|\bbaler\b|\bcompactor\b|\bequipment\b|\bscrubber\b|\bbuffer\b/, "Equipment usage"],
  [/\bcustomers?\b|\bshopper\b|\bguest\b/, "Customer assistance"],
  [/\btrain(ing|ed)?\b|\bteach(ing)?\b|\bshowed\b|\bshowing\b|\bcoach(ing|ed)\b/, "Teaching & training"],
  [/\bhuddle\b|\bsafety (talk|routine|walk|sweep)\b|\broutine\b/, "Safety routine/practice"],
  [/\bcompliance\b|\bblocked (exit|panel|eyewash)\b|\bfire (exit|door|extinguisher)\b|\begress\b|\belectrical panel\b/, "Compliance safety"],
  [/\boutside\b|\bpushing carts\b|\bcarts? (in|from) the\b|\bparking\b/, "Working outside"],
  [/\bacc service\b|\btire (change|rotation)\b|\boil change\b/, "ACC service"],
  [/\b(shrink|stretch) ?wrap|\bstock(ing|ed|s)?\b|\bzon(e|ing)\b|\btop ?stock\b|\bbinning\b|\bfacing\b|\bworking (a )?(pallet|freight)\b|\bfreight\b/, "Stocking"],
];

const TOOL_RULES = [
  [/\bspill station\b/, "Spill station"],
  [/\b10 ?(ft|foot|feet)\b|\bten ?(ft|foot|feet)\b|\b10-foot\b/, "10ft Rule"],
  [/\bladder\b|\bstep ?stool\b/, "Ladder"],
  [/\bbox ?cutter\b|\bknife\b|\bsafety cutter\b|\bblade\b/, "Box Cutter"],
  [/\bsafety vest\b|\bvest\b/, "Safety vest"],
  [/\bppe\b|\bgloves?\b|\bgoggles\b|\bsafety glasses\b|\bhard hat\b|\bsteel toe/, "Personal Protective Equipment"],
  [/\bforklift\b|\belectric pallet jack\b|\bepj\b|\bstocker\b|\bscrubber\b|\bpowered\b|\bmotorized\b/, "Powered equipment"],
  [/\bbaler\b|\bcompactor\b|\bdock (plate|leveler)\b|\bconveyor\b|\bbale\b/, "Backroom equipment"],
  [/\btire (machine|changer)\b|\blift (bay|rack)\b|\bjack stands?\b|\bacc equipment\b/, "ACC equipment"],
  [/\bshopping carts?\b|\bcart corral\b|\bcustomer carts?\b|\bpushing carts\b/, "Shopping cart"],
  [/\bopd cart\b|\btop ?stock cart\b|\brocket\b|\bu-?boat\b|\bflat ?bed\b|\bcarts?\b/, "Cart (OPD, Topstock, etc.)"],
  [/\bpallet ?jack\b|\bmanual (jack|equipment)\b|\bhand truck\b|\bdolly\b/, "Manual equipment"],
  [/\bmop\b|\bbroom\b|\bclean(ing)? suppl|\bspill\b|\bwet floor sign\b|\bsweep|\bpaper towels?\b|\bsqueegee\b/, "Cleaning supplies"],
  [/\bshel(f|ves)\b|\bfixtures?\b|\bracks?\b|\bmodular\b|\bendcap\b|\bgondola\b|\bsteel\b/, "Fixture"],
  [/\bboxe?s?\b|\bcases?\b|\bcartons?\b/, "Box-case"],
  [/\bpallets?\b|\bmerchandise\b|\bproducts?\b|\bfreight\b|\bitems?\b/, "Merchandise"],
];

// Unsafe behaviour → Engagement. "climbing on <anything but a ladder>",
// missing PPE, a correction someone made. Checked before the safe cues.
const UNSAFE_RE = new RegExp([
  "\\bunsafe(ly)?\\b", "\\bimproper(ly)?\\b", "\\bincorrect(ly)?\\b", "\\bnot (wearing|using|following)\\b",
  "\\bwithout (a |an |their |his |her )?(gloves|ppe|vest|ladder|goggles|safety|spotter|wet floor)\\b",
  "\\bno (gloves|ppe|vest|goggles|wet floor sign|spotter)\\b", "\\bclimb(ing|ed|s)? (on|up)( a| the)? (?!ladder|step ?stool)",
  "\\bstanding on( a| the)? (?!ladder|step ?stool)", "\\bstood on\\b", "\\bjump(ing|ed)?\\b", "\\brunning\\b", "\\briding\\b",
  "\\bcorrected\\b", "\\bengaged\\b", "\\breminded\\b", "\\bhad to (stop|tell|remind)\\b", "\\bstopped (him|her|them)\\b",
  "\\bblock(ing|ed)\\b", "\\bleft (out|open|unattended)\\b", "\\bpointed (at|toward)\\b", "\\bcutting toward\\b",
  "\\bovershoot|\\boverload(ed)?\\b", "\\btwisting\\b", "\\bbending at the waist\\b", "\\bhorseplay\\b",
  "\\bon (his|her|their) phone\\b", "\\bwalked past (a |the )?spill\\b", "\\bignor(ed|ing)\\b",
].join("|"));
const SAFE_RE = /\bproperly\b|\bsafely\b|\bcorrectly\b|\bgreat (job|catch)\b|\bgood (job|catch)\b|\brecogni[sz]ed?\b|\bfollow(ing|ed)\b|\bwearing\b|\bwith (a |the )?(mop|broom|ladder|gloves|spotter|wet floor sign|spill station)\b|\bcleaning (up )?(a |the )?spill\b|\busing (a |the |his |her |their )?\w+/;

const pick = (text, rules) => {
  for (const [re, value] of rules) if (re.test(text)) return value;
  return null;
};

/** "11am", "11:30 am", "3 pm", "at 14:00" → hour 0-23; null when no time is named. */
export function hourFromText(text) {
  const s = String(text || "").toLowerCase();
  let m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith("p")) h += 12;
    return h <= 23 ? h : null;
  }
  m = s.match(/\bat (\d{1,2}):(\d{2})\b/);
  if (m && Number(m[1]) <= 23) return Number(m[1]);
  if (/\bnoon\b/.test(s)) return 12;
  if (/\bmidnight\b/.test(s)) return 0;
  return null;
}

/**
 * @param {string} sentence
 * @param {{now?: Date}} [opts]
 * @returns {{answers: object, guessed: string[], missing: string[], hour: number|null}}
 */
export function parseObservation(sentence, { now = new Date() } = {}) {
  const raw = String(sentence || "").replace(/\s+/g, " ").trim();
  const text = raw.toLowerCase();
  const guessed = [];

  const unsafe = UNSAFE_RE.test(text);
  const safe = SAFE_RE.test(text);
  const type = unsafe ? "Engagement" : "Recognition";
  if (!unsafe && !safe) guessed.push("type");

  const hour = hourFromText(text);
  const shift = shiftForHour(hour ?? now.getHours());

  const location = pick(text, LOCATION_RULES);
  let process = pick(text, PROCESS_RULES);
  let tool = pick(text, TOOL_RULES);
  if (!process) { process = "Safety routine/practice"; guessed.push("process"); }
  if (!tool) { tool = "Associate Actions"; guessed.push("tool"); }

  const answers = {
    shift, type, location, process, tool,
    description: type === "Recognition" ? sentenceCase(raw) : "",
  };
  const missing = [];
  if (!location) missing.push("location");
  if (!raw) missing.push("description");
  return { answers, guessed, missing, hour };
}

function sentenceCase(s) {
  if (!s) return "";
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : t + ".";
}

/**
 * Overlay an AI pick onto the rule answers, field by field, keeping only
 * values that are on the form's list. Returns the merged answers plus the
 * keys the AI changed.
 */
export function mergeAiPick(ruleAnswers, ai = {}) {
  const lists = { type: TYPES, location: LOCATIONS, process: PROCESSES, tool: TOOLS };
  const out = { ...ruleAnswers };
  const changed = [];
  for (const [k, list] of Object.entries(lists)) {
    const v = String(ai?.[k] ?? "").trim();
    const hit = list.find((c) => c.toLowerCase() === v.toLowerCase());
    if (hit && hit !== out[k]) { out[k] = hit; changed.push(k); }
  }
  if (out.type !== "Recognition") out.description = "";
  else if (!out.description && ai?.description) out.description = String(ai.description).trim();
  return { answers: out, changed };
}
