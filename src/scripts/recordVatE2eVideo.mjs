/**
 * Records a real E2E VAT demo video:
 * 1) Runs API E2E suite (must pass 14/14)
 * 2) Walks the UI through the actual working bookings/payments created by those tests
 *
 * Usage: node src/scripts/recordVatE2eVideo.mjs
 */
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const BASE = process.env.DEMO_BASE_URL || "http://127.0.0.1:3000";
const PASSWORD = "vatE2eTest123!";
const OUT_DIR = process.env.DEMO_OUT_DIR || "/opt/cursor/artifacts/videos";
const STATE_PATH = process.env.VAT_E2E_STATE_PATH || "/opt/cursor/artifacts/vat-e2e-state.json";
const SLOW_MO = Number(process.env.DEMO_SLOW_MO || 280);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runE2E() {
  console.log("Running full VAT API E2E suite (must pass 14/14)...");
  execSync("npx tsx src/scripts/e2eVatFlow.ts all", {
    cwd: "/agent/repos/fixera-server",
    stdio: "inherit",
    env: { ...process.env, VAT_E2E_STATE_PATH: STATE_PATH },
  });
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`E2E state file missing: ${STATE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

async function showChapter(page, title, subtitle = "", badge = "") {
  await page.evaluate(
    ({ title, subtitle, badge }) => {
      const id = "vat-demo-chapter";
      document.getElementById(id)?.remove();
      const el = document.createElement("div");
      el.id = id;
      el.style.cssText = [
        "position:fixed",
        "top:20px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:99999",
        "background:rgba(15,23,42,0.94)",
        "color:#fff",
        "padding:14px 24px",
        "border-radius:12px",
        "box-shadow:0 12px 40px rgba(0,0,0,0.35)",
        "font-family:system-ui,sans-serif",
        "text-align:center",
        "pointer-events:none",
        "max-width:90vw",
      ].join(";");
      el.innerHTML = [
        badge ? `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#86efac;margin-bottom:6px">${badge}</div>` : "",
        `<div style="font-size:20px;font-weight:700">${title}</div>`,
        subtitle ? `<div style="font-size:13px;opacity:.88;margin-top:6px">${subtitle}</div>` : "",
      ].join("");
      document.body.appendChild(el);
    },
    { title, subtitle, badge }
  );
  await sleep(2400);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|admin|projects|bookings|profile/, { timeout: 45000 });
  await sleep(1000);
}

async function pickCalendarDate(page, isoDate) {
  const [, , day] = isoDate.split("-").map(Number);
  await page.getByRole("button", { name: /select a date/i }).click();
  await sleep(800);
  const dayBtn = page.locator(".rdp-day_button").filter({ hasText: new RegExp(`^${day}$`) }).first();
  await dayBtn.waitFor({ state: "visible", timeout: 15000 });
  await dayBtn.click();
  await sleep(1000);
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = runE2E();
  console.log("E2E state:", state);

  const browser = await chromium.launch({
    headless: true,
    slowMo: SLOW_MO,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await showChapter(
      page,
      "Fixera VAT Management — Live E2E",
      "API verification passed · now walking the real UI flows",
      `✓ ${state.scenariosPassed}/14 automated tests passed`
    );

    // ── 1. Admin VAT configuration ─────────────────────────────────────────
    await login(page, state.credentials.admin);
    await page.goto(`${BASE}/admin/services`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await showChapter(page, "1. Admin — VAT Management", "Service config: reduced VAT questions + logic rules", "E2E verified");

    await page.getByText("VAT E2E Renovation").first().scrollIntoViewIfNeeded();
    await sleep(1000);
    const editBtn = page.getByRole("button", { name: /^edit$/i }).first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await sleep(1500);
    }
    const vatMgmt = page.getByText("VAT management").first();
    await vatMgmt.scrollIntoViewIfNeeded();
    await sleep(2500);
    await page.mouse.wheel(0, 700);
    await sleep(2500);

    await page.goto(`${BASE}/admin/settings`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await showChapter(page, "2. Admin — Platform Settings", "Fixtract VAT, address, Peppol e-invoicing");
    await page.mouse.wheel(0, 500);
    await sleep(2500);

    // ── 2. Customer payment with 6% reduced VAT (E2E-verified booking) ───────
    await context.clearCookies();
    await login(page, state.credentials.b2c);

    await page.goto(`${BASE}/bookings/${state.reducedBookingId}/payment`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await showChapter(page, "3. Payment — 6% Reduced VAT", "Live payment page from E2E-verified checkout booking");
    await page.getByText(/6%|vat|€|EUR/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(4000);

    await page.goto(`${BASE}/bookings/${state.reducedBookingId}`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await showChapter(page, "4. Booking Detail — Reduced VAT", "Banner, VAT answers, and booking status");
    await page.getByText(/reduced vat|reduced rate|6%/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(3500);

    // Optional: also show booking wizard VAT questions on project page
    await page.goto(`${BASE}/projects/${state.projectId}`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await showChapter(page, "5. Booking Wizard — VAT Questions", "Reduced VAT eligibility questions in checkout flow");
    const continueBtn = page.getByRole("button", { name: /^Continue$/i }).first();
    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click();
      await sleep(2000);
      await page.getByText("Reduced VAT questions").first().scrollIntoViewIfNeeded().catch(() => {});
      await sleep(3000);
    }

    // ── 3. VAT RFQ review flow ─────────────────────────────────────────────
    await page.goto(`${BASE}/bookings/${state.rfqVatBookingId}`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await showChapter(page, "6. VAT RFQ Review", "Ambiguous answers → proceed at standard rate");
    await page.getByText(/vat review|standard vat|quotation review/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(2500);

    const proceedStandard = page.getByRole("button", { name: /proceed at standard/i });
    if (await proceedStandard.isVisible().catch(() => false)) {
      await proceedStandard.click();
      await sleep(3000);
    }

    // ── 4. B2B reverse charge profile ──────────────────────────────────────
    await context.clearCookies();
    await login(page, state.credentials.b2bDe);
    await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await showChapter(page, "7. B2B EU Customer", "Verified VAT → 0% reverse charge at checkout");
    await page.getByText(/business|vat|DE811569869/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(3000);

    // ── 5. Professional quotation with multi-line VAT ────────────────────────
    await context.clearCookies();
    await login(page, state.credentials.pro);
    await page.goto(`${BASE}/bookings/${state.rfqPackageBookingId}`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await showChapter(page, "8. Quotation — Multi-line VAT", "E2E-submitted quote: 6% labour + 21% materials");
    await page.mouse.wheel(0, 800);
    await sleep(2500);
    await page.getByText(/6%|21%|pricing|quotation|labour|materials/i).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(3500);

    const quoteBtn = page.getByRole("button", { name: /quotation|view quote|quote details/i }).first();
    if (await quoteBtn.isVisible().catch(() => false)) {
      await quoteBtn.click();
      await sleep(2500);
    }

    // ── 6. Admin invoice generation ────────────────────────────────────────
    await context.clearCookies();
    await login(page, state.credentials.admin);
    await page.goto(`${BASE}/admin/payments`, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    await showChapter(page, "9. Admin — Invoice + UBL", "Generate PDF invoice and Peppol UBL on live payment");

    const invoiceBtn = page.getByRole("button", { name: /generate invoice/i }).first();
    if (await invoiceBtn.isVisible().catch(() => false)) {
      await invoiceBtn.scrollIntoViewIfNeeded();
      await sleep(1000);
      await invoiceBtn.click();
      await sleep(5000);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(2500);
    const invoiceLink = page.getByText(/invoice|ubl|\.pdf|\.xml/i).first();
    await invoiceLink.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(3500);

    await showChapter(
      page,
      "E2E Complete",
      `${state.scenariosPassed}/14 API tests + full UI walkthrough on live data`,
      "✓ VAT management working"
    );
    await sleep(3000);
  } catch (err) {
    console.error("Video recording error (saving partial video):", err?.message || err);
    try {
      await showChapter(page, "Recording interrupted", String(err?.message || err), "⚠");
      await sleep(1500);
    } catch { /* ignore */ }
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();

    if (video) {
      const webmPath = await video.path();
      const mp4Path = path.join(OUT_DIR, "fixera-vat-e2e-full-demo.mp4");
      execSync(
        `ffmpeg -y -i "${webmPath}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -movflags +faststart "${mp4Path}"`,
        { stdio: "inherit" }
      );
      try { fs.unlinkSync(webmPath); } catch { /* ignore */ }
      console.log("VIDEO_READY:", mp4Path);
    }
  }
}

run().then(() => {
  console.log("Recording finished.");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
