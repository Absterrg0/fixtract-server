import { describe, expect, it, vi, beforeEach } from "vitest";

const { findOneMock } = vi.hoisted(() => ({ findOneMock: vi.fn() }));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { findOne: findOneMock },
}));

import {
  resolveVatDecisionFromConfig,
  resolveSupplierB2BInvoiceDecision,
} from "../../utils/vatManagement";

const mockConfig = (config: unknown) => {
  findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(config) });
};

const baseConfig = {
  category: "Cleaning",
  vatManagement: { enabled: false, article47Classification: "immovable" },
};

describe("VAT SSOT branch table — customer leg", () => {
  beforeEach(() => findOneMock.mockReset());

  const cases: Array<{
    name: string;
    params: Parameters<typeof resolveVatDecisionFromConfig>[0];
    expect: { country: string; reverseCharge: boolean; appliedRate?: number };
  }> = [
    {
      name: "B2C immovable -> booking country, standard, no RC",
      params: { country: "BE", bookingCountry: "BE", customerType: "individual" },
      expect: { country: "BE", reverseCharge: false, appliedRate: 21 },
    },
    {
      name: "B2B movable -> business country",
      params: { bookingCountry: "BE", businessCountry: "NL", propertyNature: "movable", customerType: "business", vatNumber: "NL123456789B01", isVatVerified: false },
      expect: { country: "NL", reverseCharge: false },
    },
    {
      name: "B2B immovable BE verified -> RC",
      params: { country: "BE", bookingCountry: "BE", customerType: "business", vatNumber: "BE0123456789", isVatVerified: true, propertyNature: "immovable" },
      expect: { country: "BE", reverseCharge: true, appliedRate: 0 },
    },
    {
      name: "B2B movable BE verified -> no RC (BE branch)",
      params: { country: "BE", bookingCountry: "BE", customerType: "business", vatNumber: "BE0123456789", isVatVerified: true, propertyNature: "movable" },
      expect: { country: "BE", reverseCharge: false },
    },
    {
      name: "B2B CH exception -> no RC",
      params: { country: "CH", bookingCountry: "CH", customerType: "business", vatNumber: "CHE123456789", isVatVerified: true },
      expect: { country: "CH", reverseCharge: false },
    },
    {
      name: "unverified B2B -> no RC",
      params: { country: "NL", bookingCountry: "NL", customerType: "business", vatNumber: "NL123456789B01", isVatVerified: false },
      expect: { country: "NL", reverseCharge: false },
    },
    {
      name: "unknown country -> rfq with trace",
      params: { country: "Atlantis", customerType: "individual" },
      expect: { country: "", reverseCharge: false },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      mockConfig(baseConfig);
      const decision = await resolveVatDecisionFromConfig(c.params as any);
      expect(decision.country).toBe(c.expect.country);
      expect(decision.reverseCharge).toBe(c.expect.reverseCharge);
      if (c.expect.appliedRate !== undefined) expect(decision.appliedRate).toBe(c.expect.appliedRate);
      expect(Array.isArray(decision.trace)).toBe(true);
      expect(decision.trace!.length).toBeGreaterThan(0);
    });
  }
});

describe("VAT SSOT branch table — supplier leg", () => {
  const cases: Array<{
    name: string;
    params: Parameters<typeof resolveSupplierB2BInvoiceDecision>[0];
    expect: { country: string; reverseCharge: boolean };
  }> = [
    {
      name: "supplier immovable -> booking country",
      params: { supplierCountry: "NL", buyerCountry: "BE", bookingCountry: "DE", supplierVatNumber: "NL123456789B01", buyerVatNumber: "BE1002103337", propertyNature: "immovable" },
      expect: { country: "DE", reverseCharge: true },
    },
    {
      name: "supplier movable -> professional country",
      params: { supplierCountry: "NL", buyerCountry: "BE", supplierVatNumber: "NL123456789B01", buyerVatNumber: "BE1002103337", propertyNature: "movable" },
      expect: { country: "NL", reverseCharge: true },
    },
    {
      name: "supplier BE movable -> no RC",
      params: { supplierCountry: "BE", buyerCountry: "BE", supplierVatNumber: "BE0123456789", buyerVatNumber: "BE1002103337", propertyNature: "movable" },
      expect: { country: "BE", reverseCharge: false },
    },
    {
      name: "supplier BE immovable verified -> RC",
      params: { supplierCountry: "BE", buyerCountry: "BE", bookingCountry: "BE", supplierVatNumber: "BE0123456789", buyerVatNumber: "BE1002103337", propertyNature: "immovable" },
      expect: { country: "BE", reverseCharge: true },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const decision = resolveSupplierB2BInvoiceDecision(c.params);
      expect(decision.country).toBe(c.expect.country);
      expect(decision.reverseCharge).toBe(c.expect.reverseCharge);
      expect(Array.isArray(decision.trace)).toBe(true);
    });
  }
});
