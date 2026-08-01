# Brevo marketing setup

Fixera owns campaign targeting, scheduling, consent, and delivery history. Brevo
provides the reusable email templates, contact lists, campaign delivery, and
delivery statistics.

## 1. Authenticate the sending domain

1. In Brevo, add the production sending domain.
2. Add every DNS record Brevo supplies through Cloudflare.
3. Keep mail-related records set to DNS-only, not proxied.
4. Wait until Brevo reports the domain as authenticated.
5. Create and verify the production sender address used by `FROM_EMAIL`.

Use a role address on the authenticated domain, for example
`updates@fixtract.com`. Configure replies to reach a monitored inbox.

## 2. Create the API key

Create a dedicated production API key in Brevo. Store it only in the server
deployment as `BREVO_API_KEY`. Do not expose it through a `NEXT_PUBLIC_*`
variable or add it to the frontend deployment.

Fixera uses the key for:

- contact folders, lists, attributes, and asynchronous contact imports;
- marketing campaign creation, send, and statistics;
- listing active transactional templates for the admin campaign editor.

The server automatically creates the `Fixtract Campaigns` contact folder and
the `FIRSTNAME`, `REGION`, `LOCALE`, and `UNSUB_TOKEN` contact attributes when
needed.

## 3. Create reusable templates

Create active templates in Brevo under Transactional > Templates. Use one
template per campaign type and locale, for example:

- `newsletter-en`, `newsletter-nl`, `newsletter-fr`
- `promotion-en`, `promotion-nl`, `promotion-fr`
- `reengagement-en`, `reengagement-nl`, `reengagement-fr`

Templates can use these contact variables:

```text
{{ contact.FIRSTNAME }}
{{ contact.REGION }}
{{ contact.LOCALE }}
```

Do not hard-code an unsubscribe URL in a template. Fixera attaches the signed,
non-expiring unsubscribe link and notification-preferences link as the Brevo
campaign footer for both template-based and inline campaigns.

Keep every production template active. An inactive template is not offered for
new campaigns, although an existing draft continues to display its saved
template ID.

## 4. Configure the server

Set these values in the production server environment:

```dotenv
BREVO_API_KEY=
FROM_EMAIL=updates@fixtract.com
BREVO_SENDER_NAME=Fixtract
FRONTEND_URL=https://fixtract.com
BREVO_IMPORT_TIMEOUT_MS=60000
MARKETING_REENGAGEMENT_INACTIVE_DAYS=60
MARKETING_ABANDONED_CHECKOUT_DISCOUNT_CODE=
MARKETING_CAMPAIGN_DRY_RUN=true
```

`BREVO_MARKETING_FOLDER_ID` is optional. Leave it unset to let Fixera create
and reuse the `Fixtract Campaigns` folder.

## 5. Production verification

1. Deploy with `MARKETING_CAMPAIGN_DRY_RUN=true`.
2. In Admin > Campaigns, sync opted-in subscribers.
3. Confirm the audience preview and the 5,000-recipient safety limit.
4. Create one campaign for each locale using the matching Brevo template.
5. Send in dry-run mode and confirm Fixera records one delivery per locale.
6. Set `MARKETING_CAMPAIGN_DRY_RUN=false`.
7. Send a live campaign to internal opted-in accounts only.
8. Verify rendering, links, reply handling, and unsubscribe behavior.
9. Confirm the user is excluded after another subscriber sync.
10. Refresh campaign statistics and confirm Brevo counts are stored.

Do not import legacy users as opted in. A user enters the marketing audience
only after explicitly enabling promotional email, which records
`marketingConsentAt`. An unsubscribe remains effective until that user
explicitly opts in again.
