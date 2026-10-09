/**
 * Countries a sign-in code can be texted to, and how a typed number becomes
 * the `+<country code><number>` the server and Twilio take.
 *
 * The phone field starts on the United States and offers every other country
 * from a list (Dev2, 2026-10-09: "default to us country code, and add a
 * dropdown for other country area codes that twilio supports"). Twilio Verify
 * texts to every country below; which ones it actually delivers to is the
 * Twilio account's geo permissions, not this list.
 *
 * Pure, so it can be tested without a screen.
 */

export interface PhoneCountry {
  /** ISO 3166-1 alpha-2, which also draws the flag. */
  iso: string;
  name: string;
  /**
   * Digits only, without the plus. Every country in the North American plan
   * is "1": its area code is part of the number people type, not the code.
   */
  dial: string;
}

export const DEFAULT_COUNTRY_ISO = "US";

// prettier-ignore
const ROWS: readonly (readonly [string, string, string])[] = [
  ["AF", "Afghanistan", "93"], ["AL", "Albania", "355"], ["DZ", "Algeria", "213"],
  ["AS", "American Samoa", "1"], ["AD", "Andorra", "376"], ["AO", "Angola", "244"],
  ["AI", "Anguilla", "1"], ["AG", "Antigua and Barbuda", "1"], ["AR", "Argentina", "54"],
  ["AM", "Armenia", "374"], ["AW", "Aruba", "297"], ["AU", "Australia", "61"],
  ["AT", "Austria", "43"], ["AZ", "Azerbaijan", "994"], ["BS", "Bahamas", "1"],
  ["BH", "Bahrain", "973"], ["BD", "Bangladesh", "880"], ["BB", "Barbados", "1"],
  ["BY", "Belarus", "375"], ["BE", "Belgium", "32"], ["BZ", "Belize", "501"],
  ["BJ", "Benin", "229"], ["BM", "Bermuda", "1"], ["BT", "Bhutan", "975"],
  ["BO", "Bolivia", "591"], ["BA", "Bosnia and Herzegovina", "387"], ["BW", "Botswana", "267"],
  ["BR", "Brazil", "55"], ["VG", "British Virgin Islands", "1"], ["BN", "Brunei", "673"],
  ["BG", "Bulgaria", "359"], ["BF", "Burkina Faso", "226"], ["BI", "Burundi", "257"],
  ["KH", "Cambodia", "855"], ["CM", "Cameroon", "237"], ["CA", "Canada", "1"],
  ["CV", "Cape Verde", "238"], ["KY", "Cayman Islands", "1"], ["CF", "Central African Republic", "236"],
  ["TD", "Chad", "235"], ["CL", "Chile", "56"], ["CN", "China", "86"],
  ["CO", "Colombia", "57"], ["KM", "Comoros", "269"], ["CG", "Congo", "242"],
  ["CD", "Congo (DRC)", "243"], ["CK", "Cook Islands", "682"], ["CR", "Costa Rica", "506"],
  ["CI", "Côte d'Ivoire", "225"], ["HR", "Croatia", "385"], ["CU", "Cuba", "53"],
  ["CW", "Curaçao", "599"], ["CY", "Cyprus", "357"], ["CZ", "Czechia", "420"],
  ["DK", "Denmark", "45"], ["DJ", "Djibouti", "253"], ["DM", "Dominica", "1"],
  ["DO", "Dominican Republic", "1"], ["EC", "Ecuador", "593"], ["EG", "Egypt", "20"],
  ["SV", "El Salvador", "503"], ["GQ", "Equatorial Guinea", "240"], ["ER", "Eritrea", "291"],
  ["EE", "Estonia", "372"], ["SZ", "Eswatini", "268"], ["ET", "Ethiopia", "251"],
  ["FK", "Falkland Islands", "500"], ["FO", "Faroe Islands", "298"], ["FJ", "Fiji", "679"],
  ["FI", "Finland", "358"], ["FR", "France", "33"], ["GF", "French Guiana", "594"],
  ["PF", "French Polynesia", "689"], ["GA", "Gabon", "241"], ["GM", "Gambia", "220"],
  ["GE", "Georgia", "995"], ["DE", "Germany", "49"], ["GH", "Ghana", "233"],
  ["GI", "Gibraltar", "350"], ["GR", "Greece", "30"], ["GL", "Greenland", "299"],
  ["GD", "Grenada", "1"], ["GP", "Guadeloupe", "590"], ["GU", "Guam", "1"],
  ["GT", "Guatemala", "502"], ["GG", "Guernsey", "44"], ["GN", "Guinea", "224"],
  ["GW", "Guinea-Bissau", "245"], ["GY", "Guyana", "592"], ["HT", "Haiti", "509"],
  ["HN", "Honduras", "504"], ["HK", "Hong Kong", "852"], ["HU", "Hungary", "36"],
  ["IS", "Iceland", "354"], ["IN", "India", "91"], ["ID", "Indonesia", "62"],
  ["IR", "Iran", "98"], ["IQ", "Iraq", "964"], ["IE", "Ireland", "353"],
  ["IM", "Isle of Man", "44"], ["IL", "Israel", "972"], ["IT", "Italy", "39"],
  ["JM", "Jamaica", "1"], ["JP", "Japan", "81"], ["JE", "Jersey", "44"],
  ["JO", "Jordan", "962"], ["KZ", "Kazakhstan", "7"], ["KE", "Kenya", "254"],
  ["KI", "Kiribati", "686"], ["XK", "Kosovo", "383"], ["KW", "Kuwait", "965"],
  ["KG", "Kyrgyzstan", "996"], ["LA", "Laos", "856"], ["LV", "Latvia", "371"],
  ["LB", "Lebanon", "961"], ["LS", "Lesotho", "266"], ["LR", "Liberia", "231"],
  ["LY", "Libya", "218"], ["LI", "Liechtenstein", "423"], ["LT", "Lithuania", "370"],
  ["LU", "Luxembourg", "352"], ["MO", "Macao", "853"], ["MG", "Madagascar", "261"],
  ["MW", "Malawi", "265"], ["MY", "Malaysia", "60"], ["MV", "Maldives", "960"],
  ["ML", "Mali", "223"], ["MT", "Malta", "356"], ["MH", "Marshall Islands", "692"],
  ["MQ", "Martinique", "596"], ["MR", "Mauritania", "222"], ["MU", "Mauritius", "230"],
  ["YT", "Mayotte", "262"], ["MX", "Mexico", "52"], ["FM", "Micronesia", "691"],
  ["MD", "Moldova", "373"], ["MC", "Monaco", "377"], ["MN", "Mongolia", "976"],
  ["ME", "Montenegro", "382"], ["MS", "Montserrat", "1"], ["MA", "Morocco", "212"],
  ["MZ", "Mozambique", "258"], ["MM", "Myanmar", "95"], ["NA", "Namibia", "264"],
  ["NR", "Nauru", "674"], ["NP", "Nepal", "977"], ["NL", "Netherlands", "31"],
  ["NC", "New Caledonia", "687"], ["NZ", "New Zealand", "64"], ["NI", "Nicaragua", "505"],
  ["NE", "Niger", "227"], ["NG", "Nigeria", "234"], ["MK", "North Macedonia", "389"],
  ["MP", "Northern Mariana Islands", "1"], ["NO", "Norway", "47"], ["OM", "Oman", "968"],
  ["PK", "Pakistan", "92"], ["PW", "Palau", "680"], ["PS", "Palestine", "970"],
  ["PA", "Panama", "507"], ["PG", "Papua New Guinea", "675"], ["PY", "Paraguay", "595"],
  ["PE", "Peru", "51"], ["PH", "Philippines", "63"], ["PL", "Poland", "48"],
  ["PT", "Portugal", "351"], ["PR", "Puerto Rico", "1"], ["QA", "Qatar", "974"],
  ["RE", "Réunion", "262"], ["RO", "Romania", "40"], ["RU", "Russia", "7"],
  ["RW", "Rwanda", "250"], ["KN", "Saint Kitts and Nevis", "1"], ["LC", "Saint Lucia", "1"],
  ["MF", "Saint Martin", "590"], ["PM", "Saint Pierre and Miquelon", "508"],
  ["VC", "Saint Vincent and the Grenadines", "1"], ["WS", "Samoa", "685"],
  ["SM", "San Marino", "378"], ["ST", "São Tomé and Príncipe", "239"], ["SA", "Saudi Arabia", "966"],
  ["SN", "Senegal", "221"], ["RS", "Serbia", "381"], ["SC", "Seychelles", "248"],
  ["SL", "Sierra Leone", "232"], ["SG", "Singapore", "65"], ["SX", "Sint Maarten", "1"],
  ["SK", "Slovakia", "421"], ["SI", "Slovenia", "386"], ["SB", "Solomon Islands", "677"],
  ["SO", "Somalia", "252"], ["ZA", "South Africa", "27"], ["KR", "South Korea", "82"],
  ["SS", "South Sudan", "211"], ["ES", "Spain", "34"], ["LK", "Sri Lanka", "94"],
  ["SD", "Sudan", "249"], ["SR", "Suriname", "597"], ["SE", "Sweden", "46"],
  ["CH", "Switzerland", "41"], ["SY", "Syria", "963"], ["TW", "Taiwan", "886"],
  ["TJ", "Tajikistan", "992"], ["TZ", "Tanzania", "255"], ["TH", "Thailand", "66"],
  ["TL", "Timor-Leste", "670"], ["TG", "Togo", "228"], ["TO", "Tonga", "676"],
  ["TT", "Trinidad and Tobago", "1"], ["TN", "Tunisia", "216"], ["TR", "Türkiye", "90"],
  ["TM", "Turkmenistan", "993"], ["TC", "Turks and Caicos Islands", "1"], ["TV", "Tuvalu", "688"],
  ["VI", "U.S. Virgin Islands", "1"], ["UG", "Uganda", "256"], ["UA", "Ukraine", "380"],
  ["AE", "United Arab Emirates", "971"], ["GB", "United Kingdom", "44"], ["US", "United States", "1"],
  ["UY", "Uruguay", "598"], ["UZ", "Uzbekistan", "998"], ["VU", "Vanuatu", "678"],
  ["VA", "Vatican City", "39"], ["VE", "Venezuela", "58"], ["VN", "Vietnam", "84"],
  ["YE", "Yemen", "967"], ["ZM", "Zambia", "260"], ["ZW", "Zimbabwe", "263"],
];

export const PHONE_COUNTRIES: readonly PhoneCountry[] = ROWS.map(([iso, name, dial]) => ({ iso, name, dial }));

const BY_ISO = new Map(PHONE_COUNTRIES.map((country) => [country.iso, country]));

export function countryByIso(iso: string): PhoneCountry {
  return BY_ISO.get(iso) ?? BY_ISO.get(DEFAULT_COUNTRY_ISO)!;
}

/** The flag emoji for an ISO code: two regional indicator letters. */
export function flagOf(iso: string): string {
  return String.fromCodePoint(...[...iso.toUpperCase()].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));
}

/**
 * Countries that keep the leading 0 of a national number after the country
 * code. Everywhere else a leading 0 is the trunk prefix dialled at home only
 * (a UK mobile is 07700 900123 at home, +44 7700 900123 from abroad).
 */
const KEEPS_LEADING_ZERO = new Set(["39", "378"]);

/**
 * The number to send: `+<dial><digits>`, or `""` when nothing is typed.
 *
 * A number typed or pasted with its own `+` is taken as a whole international
 * number and the picked country is ignored, so autofill and a pasted
 * "+44 7700 900123" both work whatever the picker says.
 */
export function composePhone(country: PhoneCountry, typed: string): string {
  const digits = typed.replace(/\D/g, "");
  if (typed.trim().startsWith("+")) return digits === "" ? "" : `+${digits}`;
  if (digits === "") return "";
  const national = KEEPS_LEADING_ZERO.has(country.dial) ? digits : digits.replace(/^0+/, "");
  return `+${country.dial}${national}`;
}

/**
 * The country a full `+` number begins with, by its longest matching dial
 * code. Codes several countries share (+1, +44, +7) go to the preferred one.
 */
export function countryOfNumber(phone: string): PhoneCountry | null {
  const digits = phone.trim().startsWith("+") ? phone.replace(/\D/g, "") : "";
  if (digits === "") return null;
  for (let length = Math.min(4, digits.length); length >= 1; length -= 1) {
    const dial = digits.slice(0, length);
    const preferred = PREFERRED[dial];
    if (preferred !== undefined) return countryByIso(preferred);
    const match = PHONE_COUNTRIES.find((country) => country.dial === dial);
    if (match !== undefined) return match;
  }
  return null;
}

const PREFERRED: Record<string, string> = { "1": "US", "44": "GB", "7": "RU", "39": "IT", "590": "GP", "262": "RE" };

/** A number split back into its country and the rest, to redraw the field. */
export function splitPhone(phone: string): { country: PhoneCountry; national: string } {
  const country = countryOfNumber(phone);
  if (country === null) return { country: countryByIso(DEFAULT_COUNTRY_ISO), national: phone };
  return { country, national: phone.replace(/\D/g, "").slice(country.dial.length) };
}

/** Countries whose name or code starts with what was typed, US first. */
export function searchCountries(query: string): PhoneCountry[] {
  const q = query.trim().toLowerCase().replace(/^\+/, "");
  const sorted = [countryByIso(DEFAULT_COUNTRY_ISO), ...PHONE_COUNTRIES.filter((c) => c.iso !== DEFAULT_COUNTRY_ISO)];
  if (q === "") return sorted;
  return sorted.filter(
    (c) =>
      c.name.toLowerCase().split(/[\s(]+/).some((word) => word.startsWith(q)) ||
      c.name.toLowerCase().startsWith(q) ||
      c.dial.startsWith(q) ||
      c.iso.toLowerCase() === q,
  );
}
