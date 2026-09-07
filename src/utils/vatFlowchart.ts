/**
 * VAT FLOWCHART — SHARED DECISION IMPLEMENTATION
 * ==============================================
 * This module centralizes the VAT branches currently specified in the
 * application requirements. The referenced VAT flow.xlsx was not available
 * in this workspace, so the branch comments below document the assumptions
 * used by the implementation and its regression tests; they are not a legal
 * certification of the missing spreadsheet's green/yellow branches.
 *
 * It is used INDEPENDENTLY for both legs:
 *   - customer leg  (professional -> customer, platform -> customer)
 *   - supplier leg  (professional -> platform self-bill)
 *
 * Do NOT encode shortcuts such as "movable + B2B = reverse charge".
 * Every decision must flow through the explicit steps below so the chart,
 * the customer leg and the supplier leg can never drift apart.
 *
 * Flowchart steps:
 *
 *   STEP 1 — Property nature (Article 47)
 *     immovable classification            -> immovable
 *     movable classification              -> movable
 *     project_dependent + professional yes -> immovable
 *     project_dependent + professional no  -> movable
 *     project_dependent + unanswered       -> undefined (RFQ, cannot continue)
 *
 *   STEP 2 — Place of supply (VAT country), per leg
 *     CUSTOMER leg:
 *       immovable              -> booking/service address country
 *       movable + B2B          -> customer business address country
 *                                (fallback: booking country)
 *       movable + B2C/unknown  -> booking/service address country
 *     SUPPLIER leg (professional -> platform):
 *       immovable              -> booking/service address country
 *       movable                -> professional (supplier) business address
 *                                (fallback: booking country)
 *       undefined nature       -> booking country (flow continues to RFQ)
 *
 *   STEP 3 — Reverse charge (explicit, no shortcut)
 *     a) buyer must be business + verified VAT number, else NO RC
 *     b) empty country -> NO RC (RFQ upstream)
 *     c) CH/LI/NO/GR (B2B same-as-B2C) -> NO RC
 *     d) BE branch:
 *          movable                    -> NO RC (keep local rate)
 *          immovable + exempt flag    -> NO RC
 *          immovable + verified B2B   -> RC
 *     e) non-BE branch:
 *          cross-border (supplier != buyer, both VAT format-valid)
 *                                     -> RC
 *          verified EU B2B otherwise  -> RC
 *          else                       -> NO RC
 *
 *   STEP 4 — Rate resolution
 *     RC                              -> 0% Reverse Charge
 *     tierOverride Standard/Reduced
 *       (quotations: professional already chose the tier, eligibility
 *        rules are IGNORED, only the country rate is resolved)
 *                                     -> country standard / reduced rate
 *     logic rule match for country    -> reduced rate / rfq
 *     else                            -> country standard rate
 */

import type { PropertyNature, VatDecision } from "./vatManagement";
import type { Article47Classification } from "./vatCountries";
import {
  ARTICLE_47_FIELD_NAME,
  B2B_SAME_AS_B2C_COUNTRIES,
  firstVatCountry,
  getStandardVatRate,
  normalizeArticle47Classification,
  parseVatCountryCode,
  REVERSE_CHARGE_LABEL,
} from "./vatCountries";
import { validateVATNumberFormat } from "./vatValidation";

export type VatLeg = "customer" | "supplier";

export interface VatFlowchartPlaceOfSupplyInput {
  leg: VatLeg;
  customerType?: string;
  propertyNature?: PropertyNature | null;
  bookingCountry?: string | null;
  customerBusinessCountry?: string | null;
  supplierBusinessCountry?: string | null;
}

export interface VatFlowchartReverseChargeInput {
  buyerType?: string;
  buyerVatNumber?: string | null;
  buyerVatVerified?: boolean;
  supplierCountry?: string | null;
  supplierVatNumber?: string | null;
  buyerCountry: string;
  propertyNature?: PropertyNature | null;
  exemptFromBelgianReverseCharge?: boolean;
}

export interface VatFlowchartTrace {
  step: string;
  detail: string;
}

const isTruthyAnswer = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "yes" || normalized === "true" || normalized === "1";
};

/** STEP 1 — Article 47 property nature. */
export function flowchartPropertyNature(params: {
  classification?: Article47Classification | string | null;
  professionalAnswers?: Record<string, unknown>;
}): { nature: PropertyNature | undefined; trace: VatFlowchartTrace[] } {
  const trace: VatFlowchartTrace[] = [];
  const classification = normalizeArticle47Classification(params.classification);
  if (classification === "immovable") {
    trace.push({ step: "art47", detail: "classification=immovable -> immovable" });
    return { nature: "immovable", trace };
  }
  if (classification === "movable") {
    trace.push({ step: "art47", detail: "classification=movable -> movable" });
    return { nature: "movable", trace };
  }
  if (classification === "project_dependent") {
    const answer = params.professionalAnswers?.[ARTICLE_47_FIELD_NAME];
    if (answer === undefined || answer === null || String(answer).trim() === "") {
      trace.push({ step: "art47", detail: "project_dependent unanswered -> undefined (RFQ)" });
      return { nature: undefined, trace };
    }
    const nature = isTruthyAnswer(answer) ? "immovable" : "movable";
    trace.push({ step: "art47", detail: `project_dependent answer=${String(answer)} -> ${nature}` });
    return { nature, trace };
  }
  trace.push({ step: "art47", detail: "no classification -> undefined" });
  return { nature: undefined, trace };
}

/** STEP 2 — Place of supply per leg. */
export function flowchartPlaceOfSupplyCountry(
  input: VatFlowchartPlaceOfSupplyInput,
): { country: string; trace: VatFlowchartTrace[] } {
  const trace: VatFlowchartTrace[] = [];
  const booking = parseVatCountryCode(input.bookingCountry);
  const customerBusiness = parseVatCountryCode(input.customerBusinessCountry);
  const supplierBusiness = parseVatCountryCode(input.supplierBusinessCountry);

  if (input.leg === "supplier") {
    if (input.propertyNature === "immovable") {
      const country = firstVatCountry(input.bookingCountry);
      trace.push({ step: "place-of-supply", detail: `supplier immovable -> booking country ${country || "(empty)"}` });
      return { country, trace };
    }
    if (input.propertyNature === "movable") {
      const country = firstVatCountry(input.supplierBusinessCountry, input.bookingCountry);
      trace.push({
        step: "place-of-supply",
        detail: `supplier movable -> professional business ${country || "(empty)"} (booking fallback ${booking || "(empty)"})`,
      });
      return { country, trace };
    }
    const country = firstVatCountry(input.bookingCountry);
    trace.push({ step: "place-of-supply", detail: `supplier unknown nature -> booking ${country || "(empty)"}` });
    return { country, trace };
  }

  // customer leg
  if (input.propertyNature === "immovable") {
    const country = firstVatCountry(input.bookingCountry);
    trace.push({ step: "place-of-supply", detail: `customer immovable -> booking country ${country || "(empty)"}` });
    return { country, trace };
  }
  if (input.propertyNature === "movable") {
    if (input.customerType === "business") {
      const country = firstVatCountry(input.customerBusinessCountry, input.bookingCountry);
      trace.push({
        step: "place-of-supply",
        detail: `customer movable B2B -> business ${country || "(empty)"} (booking fallback ${booking || "(empty)"}, supplier ${supplierBusiness || "(empty)"} unused)`,
      });
      return { country, trace };
    }
    const country = firstVatCountry(input.bookingCountry);
    trace.push({ step: "place-of-supply", detail: `customer movable B2C -> booking ${country || "(empty)"}` });
    return { country, trace };
  }
  const country = firstVatCountry(input.bookingCountry, input.customerBusinessCountry);
  trace.push({ step: "place-of-supply", detail: `customer unknown nature -> booking-first ${country || "(empty)"}` });
  return { country, trace };
}

function hasVerifiedVatNumber(vatNumber?: string | null, isVerified?: boolean): boolean {
  return Boolean(isVerified && vatNumber && validateVATNumberFormat(vatNumber));
}

/** STEP 3 — Reverse charge, explicit flowchart branches (no movable+B2B shortcut). */
export function flowchartReverseCharge(
  input: VatFlowchartReverseChargeInput,
): { reverseCharge: boolean; trace: VatFlowchartTrace[] } {
  const trace: VatFlowchartTrace[] = [];
  const buyerCountry = parseVatCountryCode(input.buyerCountry);
  const supplierCountry = parseVatCountryCode(input.supplierCountry);

  if (input.buyerType !== "business") {
    trace.push({ step: "reverse-charge", detail: "buyer not business -> no RC" });
    return { reverseCharge: false, trace };
  }
  if (!hasVerifiedVatNumber(input.buyerVatNumber, input.buyerVatVerified)) {
    trace.push({ step: "reverse-charge", detail: "buyer VAT missing/unverified -> no RC" });
    return { reverseCharge: false, trace };
  }
  if (!buyerCountry) {
    trace.push({ step: "reverse-charge", detail: "empty buyer country -> no RC" });
    return { reverseCharge: false, trace };
  }
  if (B2B_SAME_AS_B2C_COUNTRIES.has(buyerCountry)) {
    trace.push({ step: "reverse-charge", detail: `${buyerCountry} B2B same-as-B2C -> no RC` });
    return { reverseCharge: false, trace };
  }

  if (buyerCountry === "BE") {
    if (input.propertyNature !== "immovable") {
      trace.push({ step: "reverse-charge", detail: "BE movable/unknown -> keep local rate, no RC" });
      return { reverseCharge: false, trace };
    }
    if (input.exemptFromBelgianReverseCharge) {
      trace.push({ step: "reverse-charge", detail: "BE immovable but exempt -> no RC" });
      return { reverseCharge: false, trace };
    }
    trace.push({ step: "reverse-charge", detail: "BE immovable verified B2B -> RC" });
    return { reverseCharge: true, trace };
  }

  const supplierVatValid = Boolean(
    input.supplierVatNumber && validateVATNumberFormat(input.supplierVatNumber),
  );
  if (supplierCountry && supplierCountry !== buyerCountry && supplierVatValid) {
    trace.push({
      step: "reverse-charge",
      detail: `cross-border ${supplierCountry}->${buyerCountry} both VAT valid -> RC`,
    });
    return { reverseCharge: true, trace };
  }
  trace.push({ step: "reverse-charge", detail: `verified EU B2B ${buyerCountry} -> RC` });
  return { reverseCharge: true, trace };
}

/** STEP 4a — Tier-only rate for quotations (ignore rule eligibility). */
export function flowchartTierRateForCountry(params: {
  country: string;
  tier: "standard" | "reduced";
  standardRate?: number;
  reducedRate?: number;
  fallbackStandardRate?: number;
}): { rate: number; trace: VatFlowchartTrace } {
  const country = parseVatCountryCode(params.country);
  if (params.tier === "reduced") {
    const rate = Number.isFinite(params.reducedRate)
      ? Number(params.reducedRate)
      : Number.isFinite(params.standardRate)
        ? Number(params.standardRate)
        : Number(params.fallbackStandardRate ?? getStandardVatRate(country));
    return { rate, trace: { step: "tier-rate", detail: `tier=reduced country=${country} rate=${rate} (eligibility ignored)` } };
  }
  const rate = Number.isFinite(params.standardRate)
    ? Number(params.standardRate)
    : Number(params.fallbackStandardRate ?? getStandardVatRate(country));
  return { rate, trace: { step: "tier-rate", detail: `tier=standard country=${country} rate=${rate}` } };
}

/** Build a VatDecision shell for a leg once country + RC are known. */
export function buildLegDecisionShell(params: {
  country: string;
  standardRate: number;
  appliedRate: number;
  reverseCharge: boolean;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
  explanation: string;
}): VatDecision {
  return {
    action: params.reverseCharge ? "standard_rate" : "standard_rate",
    country: params.country,
    standardRate: params.standardRate,
    appliedRate: params.reverseCharge ? 0 : params.appliedRate,
    reverseCharge: params.reverseCharge,
    vatLabel: params.reverseCharge ? REVERSE_CHARGE_LABEL : undefined,
    propertyNature: params.propertyNature,
    exemptFromBelgianReverseCharge: params.exemptFromBelgianReverseCharge,
    explanation: params.reverseCharge ? REVERSE_CHARGE_LABEL : params.explanation,
  };
}
