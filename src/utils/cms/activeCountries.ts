const ISO_3166_ALPHA_2_CODES = new Set(
  `AW AF AO AI AX AL AD AE AR AM AS AQ TF AG AU AT AZ BI BE BJ BQ BF BD BG BH BS BA BL BY BZ BM BO BR BB BN BT BV BW CF CA CC CH CL CN CI CM CD CG CK CO KM CV CR CU CW CX KY CY CZ DE DJ DM DK DO DZ EC EG ER EH ES EE ET FI FJ FK FR FO FM GA GB GE GG GH GI GN GP GM GW GQ GR GD GL GT GF GU GY HK HM HN HR HT HU ID IM IN IO IE IR IQ IS IL IT JM JE JO JP KZ KE KG KH KI KN KR KW LA LB LR LY LC LI LK LS LT LU LV MO MF MA MC MD MG MV MX MH MK ML MT MM ME MN MP MZ MR MS MQ MU MW MY YT NA NC NE NF NG NI NU NL NO NP NR NZ OM PK PA PN PE PH PW PG PL PR KP PT PY PS PF QA RE RO RU RW SA SD SN SG GS SH SJ SB SL SV SM SO PM RS SS ST SR SK SI SE SZ SX SC SY TC TD TG TH TJ TK TM TL TO TT TN TR TV TW TZ UG UA UM UY US UZ VA VC VE VG VI VN VU WF WS YE ZA ZM ZW`.split(
    /\s+/,
  ),
);

export function isCmsCountryCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && ISO_3166_ALPHA_2_CODES.has(code);
}

export function parseCmsCountryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return isCmsCountryCode(code) ? code : undefined;
}

export function sanitizeCmsActiveCountries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (!isCmsCountryCode(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out.slice(0, 50);
}

export function isCmsContentVisibleForCountry(
  activeCountries: string[] | undefined | null,
  countryCode?: string,
): boolean {
  const countries = activeCountries || [];
  if (countries.length === 0) return true;
  if (!countryCode) return false;
  return countries.includes(countryCode);
}

/** Empty/missing activeCountries = global; otherwise match visitor country or show global-only when unknown. */
export function cmsCountryVisibilityFilter(countryCode?: string): Record<string, unknown> {
  const globalContent = [
    { activeCountries: { $size: 0 } },
    { activeCountries: { $exists: false } },
  ];
  if (countryCode) {
    return {
      $or: [...globalContent, { activeCountries: countryCode }],
    };
  }
  return { $or: globalContent };
}

export const CMS_COUNTRY_TARGETED_TYPES = new Set(["blog", "news", "faq"]);
