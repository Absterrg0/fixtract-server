/**
 * VAT management end-to-end API validation script.
 * Seeds isolated test data, then exercises the full VAT flow against a running server.
 *
 * Usage:
 *   npx tsx src/scripts/e2eVatFlow.ts seed
 *   npx tsx src/scripts/e2eVatFlow.ts test
 *   npx tsx src/scripts/e2eVatFlow.ts all
 */
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import User from "../models/user";
import ServiceConfiguration from "../models/serviceConfiguration";
import Project from "../models/project";
import Booking from "../models/booking";
import Payment from "../models/payment";
import PlatformSettings from "../models/platformSettings";
import connectDB from "../config/db";

const API_BASE = process.env.E2E_API_BASE || "http://127.0.0.1:4000";
const PASSWORD = "vatE2eTest123!";
const TEST_TAG = "vat-e2e";

type SeedIds = {
  adminId: string;
  professionalId: string;
  customerB2CId: string;
  customerB2BDeId: string;
  customerB2BBeId: string;
  serviceConfigId: string;
  projectId: string;
};

const weekdayAvailability = {
  monday: { available: true, startTime: "09:00", endTime: "17:00" },
  tuesday: { available: true, startTime: "09:00", endTime: "17:00" },
  wednesday: { available: true, startTime: "09:00", endTime: "17:00" },
  thursday: { available: true, startTime: "09:00", endTime: "17:00" },
  friday: { available: true, startTime: "09:00", endTime: "17:00" },
  saturday: { available: false, startTime: "09:00", endTime: "17:00" },
  sunday: { available: false, startTime: "09:00", endTime: "17:00" },
};

const vatManagementConfig = {
  enabled: true,
  rateRuleGroup: "renovation_category",
  reducedVatQuestions: [
    {
      question: "Is the property your primary residence?",
      fieldName: "primary_residence",
      answerType: "yes_no" as const,
      isRequired: true,
    },
    {
      question: "Property age (years)",
      fieldName: "property_age",
      answerType: "number" as const,
      unit: "years",
      isRequired: true,
    },
    {
      question: "Which renovation work types apply?",
      fieldName: "work_types",
      answerType: "checkboxes" as const,
      options: ["insulation", "roofing", "plumbing"],
      isRequired: false,
    },
  ],
  logicRules: [
    {
      country: "BE",
      standardRate: 21,
      reducedRate: 6,
      action: "reduced_rate" as const,
      customText: "Qualifies for 6% reduced VAT on renovation work.",
      priority: 0,
      isActive: true,
      conditions: [
        { fieldName: "primary_residence", operator: "equals" as const, value: true, connector: "AND" as const },
        { fieldName: "property_age", operator: "greater_than" as const, value: 10, connector: "AND" as const },
      ],
    },
    {
      country: "BE",
      standardRate: 21,
      reducedRate: 6,
      action: "rfq" as const,
      customText: "VAT eligibility needs professional review before checkout.",
      priority: 1,
      isActive: true,
      conditions: [
        { fieldName: "primary_residence", operator: "equals" as const, value: true, connector: "AND" as const },
        { fieldName: "property_age", operator: "greater_than_or_equal" as const, value: 5, connector: "AND" as const },
        { fieldName: "property_age", operator: "less_than" as const, value: 10, connector: "AND" as const },
      ],
    },
  ],
};

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function clearTestData(): Promise<void> {
  const testEmails = [
    "admin@vat-e2e.test",
    "pro@vat-e2e.test",
    "b2c@vat-e2e.test",
    "b2b-de@vat-e2e.test",
    "b2b-be@vat-e2e.test",
  ];
  const users = await User.find({ email: { $in: testEmails } }).select("_id");
  const userIds = users.map((u) => u._id);
  await Booking.deleteMany({ $or: [{ customer: { $in: userIds } }, { professional: { $in: userIds } }] });
  await Payment.deleteMany({ $or: [{ customer: { $in: userIds } }, { professional: { $in: userIds } }] });
  await Project.deleteMany({ title: /VAT E2E/i });
  await ServiceConfiguration.deleteMany({ service: /VAT E2E/i });
  await User.deleteMany({ email: { $in: testEmails } });
}

async function seed(): Promise<SeedIds> {
  await connectDB();
  await clearTestData();

  const hashed = await hashPassword(PASSWORD);

  const admin = await User.create({
    name: "VAT E2E Admin",
    email: "admin@vat-e2e.test",
    phone: "+32470000001",
    password: hashed,
    role: "admin",
    isEmailVerified: true,
    isPhoneVerified: true,
  });

  const professional = await User.create({
    name: "VAT E2E Professional",
    email: "pro@vat-e2e.test",
    phone: "+32470000002",
    password: hashed,
    role: "professional",
    professionalStatus: "approved",
    isEmailVerified: true,
    isPhoneVerified: true,
    vatNumber: "BE0429259426",
    isVatVerified: true,
    companyName: "VAT E2E Works BV",
    businessInfo: {
      companyName: "VAT E2E Works BV",
      vatNumber: "BE0429259426",
      street: "Teststraat 1",
      city: "Brussels",
      country: "Belgium",
      postalCode: "1000",
      timezone: "Europe/Brussels",
    },
    companyAvailability: weekdayAvailability,
    availability: weekdayAvailability,
    stripe: {
      accountId: process.env.E2E_STRIPE_ACCOUNT_ID || "acct_e2e_placeholder",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      onboardingCompleted: true,
      accountStatus: "active",
    },
  });

  const customerB2C = await User.create({
    name: "VAT E2E B2C Customer",
    email: "b2c@vat-e2e.test",
    phone: "+32470000003",
    password: hashed,
    role: "customer",
    customerType: "individual",
    isEmailVerified: true,
    isPhoneVerified: true,
    location: {
      type: "Point",
      coordinates: [4.3517, 50.8503],
      address: "Grand Place 1",
      city: "Brussels",
      country: "Belgium",
      postalCode: "1000",
    },
  });

  const customerB2BDe = await User.create({
    name: "VAT E2E B2B DE Customer",
    email: "b2b-de@vat-e2e.test",
    phone: "+49300000004",
    password: hashed,
    role: "customer",
    customerType: "business",
    vatNumber: "DE811569869",
    isVatVerified: true,
    businessName: "SAP Test GmbH",
    companyAddress: {
      street: "Hasso-Plattner-Ring 7",
      city: "Walldorf",
      country: "Germany",
      postalCode: "69190",
    },
    isEmailVerified: true,
    isPhoneVerified: true,
    location: {
      type: "Point",
      coordinates: [8.6421, 49.2934],
      address: "Hasso-Plattner-Ring 7",
      city: "Walldorf",
      country: "Germany",
      postalCode: "69190",
    },
  });

  const customerB2BBe = await User.create({
    name: "VAT E2E B2B BE Customer",
    email: "b2b-be@vat-e2e.test",
    phone: "+32470000005",
    password: hashed,
    role: "customer",
    customerType: "business",
    vatNumber: "BE0123456789",
    isVatVerified: true,
    businessName: "Belgian Test BV",
    companyAddress: {
      street: "Wetstraat 1",
      city: "Brussels",
      country: "Belgium",
      postalCode: "1000",
    },
    isEmailVerified: true,
    isPhoneVerified: true,
    location: {
      type: "Point",
      coordinates: [4.3711, 50.8436],
      address: "Wetstraat 1",
      city: "Brussels",
      country: "Belgium",
      postalCode: "1000",
    },
  });

  const serviceConfig = await ServiceConfiguration.create({
    category: "Interior",
    service: "VAT E2E Renovation",
    areaOfWork: "General",
    pricingOptions: [{ name: "Total price", pricingType: "fixed_price" }],
    activeCountries: ["BE", "NL", "DE"],
    isActive: true,
    vatManagement: vatManagementConfig,
  });

  const project = await Project.create({
    title: "VAT E2E Renovation Test Project",
    description: "End-to-end VAT management validation project",
    status: "published",
    priceModel: "Fixed",
    media: { images: [] },
    professionalId: professional._id,
    serviceConfigurationId: serviceConfig._id,
    category: "Interior",
    service: "VAT E2E Renovation",
    areaOfWork: "General",
    resources: [professional._id],
    minResources: 1,
    minOverlapPercentage: 70,
    distance: {
      address: "Brussels, Belgium",
      countryCode: "BE",
      useCompanyAddress: true,
      maxKmRange: 50,
      noBorders: false,
      location: { type: "Point", coordinates: [4.3517, 50.8503] },
    },
    vatManagement: vatManagementConfig,
    subprojects: [
      {
        name: "Fixed Renovation Package",
        description: "Fixed-price package for VAT checkout testing",
        projectType: ["Interior"],
        pricing: { type: "fixed", amount: 500 },
        included: [{ name: "Labour", description: "Standard renovation labour", isCustom: false }],
        materialsIncluded: false,
        materials: [],
        preparationDuration: { value: 1, unit: "days" },
        executionDuration: { value: 2, unit: "days" },
        warrantyPeriod: { value: 2, unit: "years" },
      },
      {
        name: "RFQ Renovation Package",
        description: "RFQ package for quotation VAT line testing",
        projectType: ["Interior"],
        pricing: { type: "rfq" },
        included: [{ name: "Scope review", description: "Professional scope assessment", isCustom: false }],
        materialsIncluded: false,
        materials: [],
        preparationDuration: { value: 1, unit: "days" },
        executionDuration: { value: 3, unit: "days" },
        warrantyPeriod: { value: 2, unit: "years" },
      },
    ],
    rfqQuestions: [
      { question: "Describe the renovation scope", type: "text", isRequired: true },
    ],
    extraOptions: [],
    termsConditions: [],
  });

  const settings = await PlatformSettings.getCurrentConfig();
  settings.commissionPercent = 0;
  settings.companyVatNumber = "BE0999999999";
  settings.companyAddress = {
    name: "Fixtract BV",
    street: "VAT Test Street 42",
    city: "Brussels",
    postalCode: "1000",
    country: "Belgium",
  };
  settings.eInvoicing = {
    peppolEnabled: true,
    provider: "manual",
    peppolParticipantId: "0208:BE0999999999",
  };
  await settings.save();

  const ids: SeedIds = {
    adminId: String(admin._id),
    professionalId: String(professional._id),
    customerB2CId: String(customerB2C._id),
    customerB2BDeId: String(customerB2BDe._id),
    customerB2BBeId: String(customerB2BBe._id),
    serviceConfigId: String(serviceConfig._id),
    projectId: String(project._id),
  };

  console.log(JSON.stringify({ tag: TEST_TAG, ...ids }, null, 2));
  return ids;
}

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json: any = null;
  const text = await response.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function login(email: string): Promise<string> {
  const { status, json } = await api("POST", "/api/auth/login", undefined, {
    email,
    password: PASSWORD,
  });
  if (status !== 200 || !json?.token) {
    throw new Error(`Login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  }
  return json.token as string;
}

function bookingDates(offsetDays = 1): { date: string; time: string } {
  let dt = DateTime.now().setZone("Europe/Brussels").plus({ days: offsetDays });
  while (dt.weekday > 5) dt = dt.plus({ days: 1 });
  return { date: dt.toISODate()!, time: "10:00" };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function test(): Promise<void> {
  const ids = await seed();
  await mongoose.disconnect();

  // Wait for server health
  for (let i = 0; i < 20; i++) {
    try {
      const health = await fetch(`${API_BASE}/health`);
      if (health.ok) break;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const results: Array<{ scenario: string; ok: boolean; detail?: string }> = [];

  const run = async (scenario: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ scenario, ok: true });
      console.log(`✅ ${scenario}`);
    } catch (error: any) {
      results.push({ scenario, ok: false, detail: error?.message || String(error) });
      console.error(`❌ ${scenario}: ${error?.message || error}`);
    }
  };

  const b2cToken = await login("b2c@vat-e2e.test");
  const b2bDeToken = await login("b2b-de@vat-e2e.test");
  const b2bBeToken = await login("b2b-be@vat-e2e.test");
  const proToken = await login("pro@vat-e2e.test");
  const adminToken = await login("admin@vat-e2e.test");

  await run("A1 — VAT preview standard rate (B2C, no reduced match)", async () => {
    const { status, json } = await api("POST", "/api/bookings/vat-preview", b2cToken, {
      projectId: ids.projectId,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: false },
        { fieldName: "property_age", value: 20 },
      ],
    });
    assert(status === 200, `status ${status}`);
    assert(json.data.action === "standard_rate", `action=${json.data.action}`);
    assert(json.data.appliedRate === 21, `rate=${json.data.appliedRate}`);
  });

  await run("A2 — VAT preview reduced rate (B2C, 6%)", async () => {
    const { status, json } = await api("POST", "/api/bookings/vat-preview", b2cToken, {
      projectId: ids.projectId,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: true },
        { fieldName: "property_age", value: 15 },
      ],
    });
    assert(status === 200, `status ${status}`);
    assert(json.data.action === "reduced_rate", `action=${json.data.action}`);
    assert(json.data.appliedRate === 6, `rate=${json.data.appliedRate}`);
  });

  await run("A3 — VAT preview RFQ review (B2C, ambiguous age)", async () => {
    const { status, json } = await api("POST", "/api/bookings/vat-preview", b2cToken, {
      projectId: ids.projectId,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: true },
        { fieldName: "property_age", value: 7 },
      ],
    });
    assert(status === 200, `status ${status}`);
    assert(json.data.action === "rfq", `action=${json.data.action}`);
  });

  await run("B1 — B2B EU reverse charge (DE business, 0%)", async () => {
    const { status, json } = await api("POST", "/api/bookings/vat-preview", b2bDeToken, {
      projectId: ids.projectId,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: false },
        { fieldName: "property_age", value: 20 },
      ],
    });
    assert(status === 200, `status ${status}`);
    assert(json.data.reverseCharge === true, `reverseCharge=${json.data.reverseCharge}`);
    assert(json.data.appliedRate === 0, `rate=${json.data.appliedRate}`);
  });

  await run("B2 — Belgian B2B keeps local rate (21%)", async () => {
    const { status, json } = await api("POST", "/api/bookings/vat-preview", b2bBeToken, {
      projectId: ids.projectId,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: false },
        { fieldName: "property_age", value: 20 },
      ],
    });
    assert(status === 200, `status ${status}`);
    assert(json.data.reverseCharge === false, `reverseCharge=${json.data.reverseCharge}`);
    assert(json.data.appliedRate === 21, `rate=${json.data.appliedRate}`);
  });

  await run("C1 — Admin platform settings (Fixtract VAT + Peppol)", async () => {
    const get = await api("GET", "/api/admin/platform-settings", adminToken);
    assert(get.status === 200, `GET status ${get.status}`);
    assert(get.json.data.companyVatNumber === "BE0999999999", "companyVatNumber missing");

    const put = await api("PUT", "/api/admin/platform-settings", adminToken, {
      commissionPercent: 0,
      companyVatNumber: "BE0888888888",
      companyAddress: {
        name: "Fixtract BV",
        street: "Updated Street 1",
        city: "Brussels",
        postalCode: "1000",
        country: "Belgium",
      },
      eInvoicing: {
        peppolEnabled: true,
        provider: "manual",
        peppolParticipantId: "0208:BE0888888888",
      },
    });
    assert(put.status === 200, `PUT status ${put.status}`);
    assert(put.json.data.companyVatNumber === "BE0888888888", "update failed");
  });

  await run("C2 — Admin service configuration VAT management CRUD", async () => {
    const list = await api("GET", "/api/admin/service-configurations", adminToken);
    assert(list.status === 200, `list status ${list.status}`);
    const found = (list.json.data || []).find((s: any) => s.service === "VAT E2E Renovation");
    assert(found?.vatManagement?.enabled === true, "VAT management not enabled on config");
    assert(found.vatManagement.logicRules.length >= 2, "expected logic rules");
  });

  let reducedBookingId = "";
  await run("D1 — Create booking with reduced VAT at checkout", async () => {
    const { date: startDate, time: startTime } = bookingDates(1);
    const { status, json } = await api("POST", "/api/bookings/create", b2cToken, {
      bookingType: "project",
      projectId: ids.projectId,
      selectedSubprojectIndex: 0,
      preferredStartDate: startDate,
      preferredStartTime: startTime,
      paymentAtCheckout: true,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: true },
        { fieldName: "property_age", value: 15 },
      ],
      rfqData: {
        serviceType: "VAT E2E Renovation",
        description: "Reduced VAT checkout test booking",
        answers: [],
      },
    });
    assert(status === 201 || status === 200, `status ${status}: ${JSON.stringify(json)}`);
    reducedBookingId = json.data?.booking?._id || json.data?._id || json.booking?._id;
    assert(reducedBookingId, "no booking id returned");
    assert(json.data?.booking?.vatDecision?.action === "reduced_rate" || json.booking?.vatDecision?.action === "reduced_rate", "not reduced_rate");
  });

  await run("D2 — Payment intent uses reduced VAT rate", async () => {
    assert(reducedBookingId, "missing reduced booking");
    const { status, json } = await api(
      "POST",
      `/api/bookings/${reducedBookingId}/payment-intent`,
      b2cToken,
      {}
    );
    assert(status === 200 || status === 201, `status ${status}: ${JSON.stringify(json)}`);
    const booking = json.data?.booking || json.booking;
    const vatRate = booking?.payment?.vatRate;
    assert(vatRate === 6, `expected 6% VAT, got ${vatRate}`);
  });

  let rfqVatBookingId = "";
  await run("E1 — Create booking with VAT RFQ review (no immediate checkout)", async () => {
    const { date: startDate, time: startTime } = bookingDates(3);
    const { status, json } = await api("POST", "/api/bookings/create", b2cToken, {
      bookingType: "project",
      projectId: ids.projectId,
      selectedSubprojectIndex: 0,
      preferredStartDate: startDate,
      preferredStartTime: startTime,
      paymentAtCheckout: true,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: true },
        { fieldName: "property_age", value: 7 },
      ],
      rfqData: {
        serviceType: "VAT E2E Renovation",
        description: "VAT RFQ review test booking",
        answers: [],
      },
    });
    assert(status === 201 || status === 200, `status ${status}: ${JSON.stringify(json)}`);
    rfqVatBookingId = json.data?.booking?._id || json.data?._id || json.booking?._id;
    assert(rfqVatBookingId, "no booking id");
    const action = json.data?.booking?.vatDecision?.action || json.booking?.vatDecision?.action;
    assert(action === "rfq", `expected rfq action, got ${action}`);
  });

  await run("E2 — Customer proceeds at standard VAT rate", async () => {
    assert(rfqVatBookingId, "missing rfq vat booking");
    const { status, json } = await api(
      "POST",
      `/api/bookings/${rfqVatBookingId}/vat-proceed-standard`,
      b2cToken,
      {}
    );
    assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
    const action = json.data?.vatDecision?.action || json.booking?.vatDecision?.action;
    assert(action === "standard_rate", `expected standard_rate, got ${action}`);
  });

  let rfqPackageBookingId = "";
  await run("F1 — RFQ package booking + quotation VAT rate options", async () => {
    const { status, json } = await api("POST", "/api/bookings/create", b2cToken, {
      bookingType: "project",
      projectId: ids.projectId,
      selectedSubprojectIndex: 1,
      serviceConfigurationId: ids.serviceConfigId,
      vatAnswers: [
        { fieldName: "primary_residence", value: true },
        { fieldName: "property_age", value: 15 },
      ],
      rfqData: {
        serviceType: "VAT E2E Renovation",
        description: "RFQ package quotation VAT test",
        answers: [{ question: "Describe the renovation scope", answer: "Kitchen and bathroom" }],
      },
    });
    assert(status === 201 || status === 200, `status ${status}: ${JSON.stringify(json)}`);
    rfqPackageBookingId = json.data?.booking?._id || json.data?._id || json.booking?._id;
    assert(rfqPackageBookingId, "no rfq booking id");

    const rates = await api("GET", `/api/quotations/${rfqPackageBookingId}/vat-rates`, proToken);
    assert(rates.status === 200, `vat-rates status ${rates.status}`);
    const options = rates.json.data?.options || rates.json.options || [];
    assert(options.length >= 2, `expected multiple VAT options, got ${options.length}`);
    const hasReduced = options.some((o: any) => o.rate === 6);
    const hasStandard = options.some((o: any) => o.rate === 21);
    assert(hasReduced && hasStandard, "missing reduced/standard options");
  });

  await run("F2 — Submit quotation with multi-line VAT pricing", async () => {
    assert(rfqPackageBookingId, "missing rfq package booking");
    const accept = await api("POST", `/api/quotations/${rfqPackageBookingId}/respond-rfq`, proToken, {
      action: "accepted",
    });
    assert(accept.status === 200, `respond-rfq status ${accept.status}`);

    const submit = await api("POST", `/api/quotations/${rfqPackageBookingId}/submit`, proToken, {
      scope: "Full renovation scope for VAT E2E test",
      description: "Detailed quotation for multi-line VAT pricing validation in the E2E test suite.",
      totalAmount: 1000,
      warrantyDuration: { value: 2, unit: "years" },
      materialsIncluded: false,
      materials: [],
      preparationDuration: { value: 1, unit: "days" },
      executionDuration: { value: 3, unit: "days" },
      validUntil: DateTime.now().plus({ days: 14 }).toISODate(),
      pricingLines: [
        { description: "Labour", price: 700, vatRate: 6, vatCountry: "BE", vatLabel: "Reduced 6%" },
        { description: "Materials", price: 300, vatRate: 21, vatCountry: "BE", vatLabel: "Standard 21%" },
      ],
      milestones: [
        { title: "On Project Start", amount: 500, dueCondition: "on_start" },
        { title: "On Completion", amount: 500, dueCondition: "on_milestone_completion" },
      ],
    });
    assert(submit.status === 200 || submit.status === 201, `submit status ${submit.status}: ${JSON.stringify(submit.json)}`);

    const versions = await api("GET", `/api/quotations/${rfqPackageBookingId}/versions`, b2cToken);
    assert(versions.status === 200, `versions status ${versions.status}`);
    const versionList = versions.json.data?.versions || versions.json.versions || [];
    const latest = versionList[versionList.length - 1] || versionList[0];
    const lines = latest?.pricingLines || [];
    assert(lines.length === 2, `expected 2 pricing lines, got ${lines.length}`);
  });

  await run("G1 — Admin invoice generation with UBL (Peppol manual)", async () => {
    assert(reducedBookingId, "missing booking for invoice test");
    await connectDB();

    // Simulate authorized payment for invoice artifact generation
    const booking = await Booking.findById(reducedBookingId).populate("customer professional");
    assert(booking, "booking not found");
    booking!.status = "quote_accepted";
    booking!.set("payment.status", "authorized");
    booking!.set("payment.method", "card");
    booking!.set("payment.currency", "EUR");
    booking!.set("payment.amount", 500);
    booking!.set("payment.netAmount", 500);
    booking!.set("payment.vatRate", 6);
    booking!.set("payment.vatAmount", 30);
    booking!.set("payment.totalWithVat", 530);
    booking!.set("payment.reverseCharge", false);
    booking!.set("payment.authorizedAt", new Date());
    await booking!.save();

    await Payment.findOneAndUpdate(
      { booking: reducedBookingId },
      {
        $set: {
          booking: reducedBookingId,
          bookingNumber: booking!.bookingNumber,
          customer: booking!.customer,
          professional: booking!.professional,
          status: "authorized",
          method: "card",
          currency: "EUR",
          amount: 500,
          netAmount: 500,
          vatRate: 6,
          vatAmount: 30,
          totalWithVat: 530,
          reverseCharge: false,
          authorizedAt: new Date(),
        },
      },
      { upsert: true }
    );
    await mongoose.disconnect();

    const invoice = await api(
      "POST",
      `/api/admin/payments/${(await (async () => {
        await connectDB();
        const p = await Payment.findOne({ booking: reducedBookingId });
        await mongoose.disconnect();
        return p?._id;
      })())}/invoice`,
      adminToken,
      {}
    );
    assert(invoice.status === 200 || invoice.status === 201, `invoice status ${invoice.status}: ${JSON.stringify(invoice.json)}`);
    const data = invoice.json.data || invoice.json;
    assert(data.invoiceNumber, "missing invoiceNumber");
    assert(data.invoiceUrl, "missing invoiceUrl");
    assert(data.invoiceUblUrl, "missing invoiceUblUrl (Peppol UBL)");
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log("\n=== VAT E2E SUMMARY ===");
  console.log(`Passed: ${passed}/${results.length}`);
  if (failed.length > 0) {
    console.log("Failures:");
    for (const f of failed) console.log(`  - ${f.scenario}: ${f.detail}`);
    process.exit(1);
  }
}

const mode = process.argv[2] || "all";
(async () => {
  try {
    if (mode === "seed") {
      await seed();
      await mongoose.disconnect();
      return;
    }
    if (mode === "test") {
      await test();
      return;
    }
    if (mode === "all") {
      await test();
      return;
    }
    throw new Error(`Unknown mode: ${mode}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
