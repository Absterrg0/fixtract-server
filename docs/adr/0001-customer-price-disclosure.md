# ADR 0001: Customer price disclosure and the platform commission

Status: accepted (product owner decision, booking & quotation pricing phase 1)

## Context

Customers pay a professional's price plus the platform commission. If a customer
or anonymous visitor can see the professional's price and the customer price for
the same item, they can compute the commission rate: `customer / professional - 1`.
Earlier code also exposed the rate directly (`commissionPercent`) and offered an
amount-based preview that priced any number the caller sent.

## Decision

1. **Customers and anonymous visitors** never receive a professional base or net
   amount next to its customer amount. They also never receive a commission
   amount or percentage, and never receive a payload that lets them derive the rate.
2. **The professional who owns the project or booking** keeps their stored amounts
   and their commission (their own net and commission).
3. **Admins with payments read** see everything. **Admins with bookings read only**
   see the professional amounts but not the commission.
4. **Customer prices are entity-keyed.** `POST /api/public/customer-prices` takes a
   project, a package index, the usage and the option indices. It never accepts an
   amount. The server prices the stored package with the checkout arithmetic.
5. **Checkout pricing stays on the server.** The charge uses `computeGrossBookingAmount`,
   the same function the booking read uses for `customerTotal`.
6. **The rate endpoint** (`GET /api/user/commission-rate`) returns the rate only to
   professionals and to admins with payments read.

## Consequences

- Customer prices for a package are visible to anyone who can see the project. This
  is intended: the customer already sees that price. The base price and the rate are
  never returned to customers, so a preview cannot reveal them.
- The public preview is rate limited per IP (`PRICE_PREVIEW_RATE_LIMIT`). It still
  reads the platform commission setting on each call (not cached; see the risks below).
- Every price-bearing response passes the final JSON boundary `commissionVisibility`,
  which withholds professional and commission keys for customers and anonymous callers.
  Handlers still choose the viewer role and scope the data; the boundary is the last check.
- Adding a new commission-derived key means adding it to `COMMISSION_AMOUNT_RULES` or
  `PROFESSIONAL_AMOUNT_RULES` in `src/utils/quotationVisibility.ts`. The role-matrix
  tests in `src/tests/utils/customerPriceRoleMatrix.test.ts` fail if a key is missed.

## Risks accepted for this phase

- A bookings-only admin can derive the rate from `payment.amount` and
  `professionalPayout`. The decision above does not cover that role, so it is open for a product decision.
- The rate is readable by every professional (`GET /api/user/commission-rate`), as today.
