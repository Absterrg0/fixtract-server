import { supportReasonLabel, type SupportLocale } from "../../constants/support";
import { safeSupportMeetingLink } from "./meetingLink";

const REASON_LABELS: Record<Exclude<SupportLocale, "en">, Record<string, string>> = {
  nl: {
    booking: "Boeking",
    project_creation: "Project aanmaken",
    customer: "Klant",
    payment_payout: "Betaling / uitbetaling",
    cancellation: "Annulering",
    dispute: "Geschil",
    warranty_complaint: "Garantie / klacht",
    account_profile: "Account / profiel",
    verification_documents: "Verificatie / documenten",
    services_pricing: "Diensten en prijzen",
    availability_service_area: "Beschikbaarheid / servicegebied",
    technical_problem: "Technisch probleem",
    other: "Anders",
  },
  fr: {
    booking: "Réservation",
    project_creation: "Création de projet",
    customer: "Client",
    payment_payout: "Paiement / versement",
    cancellation: "Annulation",
    dispute: "Litige",
    warranty_complaint: "Garantie / réclamation",
    account_profile: "Compte / profil",
    verification_documents: "Vérification / documents",
    services_pricing: "Services et tarifs",
    availability_service_area: "Disponibilité / zone d'intervention",
    technical_problem: "Problème technique",
    other: "Autre",
  },
};

export function localizedSupportReasonLabel(
  reason: unknown,
  locale: SupportLocale,
): string | null {
  if (typeof reason !== "string") return null;
  if (locale !== "en") {
    const translated = REASON_LABELS[locale][reason];
    if (translated) return translated;
  }
  return supportReasonLabel(reason);
}

export type SupportEmailTemplateId =
  | "support_ticket_ack"
  | "support_meeting_ack"
  | "support_ticket_reply"
  | "support_meeting_confirmed"
  | "support_meeting_link_updated"
  | "support_meeting_rescheduled"
  | "support_meeting_cancelled";

interface SupportEmailCopy {
  brand: string;
  greeting: (name: string) => string;
  ackTitle: string;
  ackIntro: string;
  ackBody: string;
  meetingAckIntro: string;
  meetingAckBody: string;
  replyTitle: string;
  replyIntro: string;
  replyLabel: string;
  confirmedTitle: string;
  confirmedIntro: string;
  linkUpdatedTitle: string;
  linkUpdatedIntro: string;
  rescheduledTitle: string;
  rescheduledIntro: string;
  cancelledTitle: string;
  cancelledIntro: string;
  linkPendingNote: string;
  previousTime: string;
  newTime: string;
  timeLabel: string;
  ticketLabel: string;
  subjectLabel: string;
  reasonLabel: string;
  linkLabel: string;
  cancellationReasonLabel: string;
  footer: string;
}

const COPY: Record<SupportLocale, SupportEmailCopy> = {
  en: {
    brand: "Fixtract Support",
    greeting: (name) => `Hello ${name},`,
    ackTitle: "We received your support request",
    ackIntro: "Thank you for contacting us. Our support team is working on your request and will answer as soon as possible.",
    ackBody: "You can reply to this request from your support page. We will keep you updated there.",
    meetingAckIntro: "Your support meeting time has been reserved. Our support team will add the meeting link shortly.",
    meetingAckBody: "Keep this time free. We will send you a confirmation with the final time and the meeting link once it has been added. No link is needed from you right now.",
    replyTitle: "New reply to your support request",
    replyIntro: "Our support team has replied to your request.",
    replyLabel: "Reply",
    confirmedTitle: "Your support meeting is confirmed",
    confirmedIntro: "Your support meeting is confirmed. The final time and meeting link are below.",
    linkUpdatedTitle: "Your support meeting link has been updated",
    linkUpdatedIntro: "The meeting link for your support meeting has been updated. Use the current link below at the scheduled time.",
    rescheduledTitle: "Your support meeting has been rescheduled",
    rescheduledIntro: "The time of your support meeting has changed. The updated details are below.",
    cancelledTitle: "Your support meeting has been cancelled",
    cancelledIntro: "Your support meeting has been cancelled and the reserved time has been released.",
    linkPendingNote: "The meeting link has not been added yet. Our support team will send it separately.",
    previousTime: "Previous time",
    newTime: "New time",
    timeLabel: "Time",
    ticketLabel: "Ticket",
    subjectLabel: "Subject",
    reasonLabel: "Reason",
    linkLabel: "Join meeting",
    cancellationReasonLabel: "Reason for cancellation",
    footer: "This message was sent by Fixtract Support. Please do not share private information outside this request.",
  },
  nl: {
    brand: "Fixtract Support",
    greeting: (name) => `Hallo ${name},`,
    ackTitle: "We hebben je supportaanvraag ontvangen",
    ackIntro: "Bedankt voor je bericht. Ons supportteam werkt aan je aanvraag en antwoordt zo snel mogelijk.",
    ackBody: "Je kunt in je supportpagina reageren op deze aanvraag. Daar houden we je op de hoogte.",
    meetingAckIntro: "Je tijd voor het supportgesprek is gereserveerd. Ons supportteam voegt binnenkort de link voor het gesprek toe.",
    meetingAckBody: "Houd deze tijd vrij. Zodra de link is toegevoegd, ontvang je een bevestiging met de definitieve tijd en de link. Je hoeft nu zelf geen link te voorzien.",
    replyTitle: "Nieuw antwoord op je supportaanvraag",
    replyIntro: "Ons supportteam heeft op je aanvraag geantwoord.",
    replyLabel: "Antwoord",
    confirmedTitle: "Je supportgesprek is bevestigd",
    confirmedIntro: "Je supportgesprek is bevestigd. De definitieve tijd en de link staan hieronder.",
    linkUpdatedTitle: "De link voor je supportgesprek is bijgewerkt",
    linkUpdatedIntro: "De link voor je supportgesprek is bijgewerkt. Gebruik de huidige link hieronder op het afgesproken tijdstip.",
    rescheduledTitle: "Je supportgesprek is verplaatst",
    rescheduledIntro: "Het tijdstip van je supportgesprek is gewijzigd. De nieuwe gegevens staan hieronder.",
    cancelledTitle: "Je supportgesprek is geannuleerd",
    cancelledIntro: "Je supportgesprek is geannuleerd en de gereserveerde tijd is vrijgegeven.",
    linkPendingNote: "De link voor het gesprek is nog niet toegevoegd. Ons supportteam stuurt die apart.",
    previousTime: "Vorige tijd",
    newTime: "Nieuwe tijd",
    timeLabel: "Tijd",
    ticketLabel: "Ticket",
    subjectLabel: "Onderwerp",
    reasonLabel: "Reden",
    linkLabel: "Gesprek openen",
    cancellationReasonLabel: "Reden van annulering",
    footer: "Dit bericht is verzonden door Fixtract Support. Deel geen privégegevens buiten deze aanvraag.",
  },
  fr: {
    brand: "Support Fixtract",
    greeting: (name) => `Bonjour ${name},`,
    ackTitle: "Nous avons reçu votre demande d'assistance",
    ackIntro: "Merci de nous avoir contactés. Notre équipe d'assistance traite votre demande et répondra dès que possible.",
    ackBody: "Vous pouvez répondre à cette demande depuis votre page d'assistance. Nous vous y tiendrons informé.",
    meetingAckIntro: "Votre créneau de réunion d'assistance est réservé. Notre équipe d'assistance ajoutera le lien de réunion prochainement.",
    meetingAckBody: "Merci de garder ce créneau disponible. Dès que le lien sera ajouté, vous recevrez une confirmation avec l'heure définitive et le lien. Vous n'avez pas de lien à fournir pour le moment.",
    replyTitle: "Nouvelle réponse à votre demande d'assistance",
    replyIntro: "Notre équipe d'assistance a répondu à votre demande.",
    replyLabel: "Réponse",
    confirmedTitle: "Votre réunion d'assistance est confirmée",
    confirmedIntro: "Votre réunion d'assistance est confirmée. L'heure définitive et le lien figurent ci-dessous.",
    linkUpdatedTitle: "Le lien de votre réunion d'assistance a été mis à jour",
    linkUpdatedIntro: "Le lien de votre réunion d'assistance a été mis à jour. Utilisez le lien actuel ci-dessous à l'heure prévue.",
    rescheduledTitle: "Votre réunion d'assistance a été reportée",
    rescheduledIntro: "L'heure de votre réunion d'assistance a changé. Les nouveaux détails figurent ci-dessous.",
    cancelledTitle: "Votre réunion d'assistance a été annulée",
    cancelledIntro: "Votre réunion d'assistance a été annulée et le créneau réservé a été libéré.",
    linkPendingNote: "Le lien de réunion n'a pas encore été ajouté. Notre équipe d'assistance vous l'enverra séparément.",
    previousTime: "Heure précédente",
    newTime: "Nouvelle heure",
    timeLabel: "Heure",
    ticketLabel: "Ticket",
    subjectLabel: "Sujet",
    reasonLabel: "Motif",
    linkLabel: "Rejoindre la réunion",
    cancellationReasonLabel: "Motif de l'annulation",
    footer: "Ce message a été envoyé par le support Fixtract. Ne partagez pas d'informations privées en dehors de cette demande.",
  },
};

const INTl_LOCALES: Record<SupportLocale, string> = {
  en: "en-GB",
  nl: "nl-BE",
  fr: "fr-BE",
};

export function escapeSupportHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function formatSupportMeetingTime(
  value: Date | string | null | undefined,
  timeZone: string | null | undefined,
  locale: SupportLocale,
): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const zone = timeZone || "UTC";
  try {
    const formatted = new Intl.DateTimeFormat(INTl_LOCALES[locale], {
      timeZone: zone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(date);
    return `${formatted} (${zone})`;
  } catch {
    return `${date.toISOString()} (UTC)`;
  }
}

interface EmailBase {
  locale: SupportLocale;
  userName?: string | null;
  ticketNumber?: string | null;
  subject?: string | null;
  reasonLabel?: string | null;
}

interface MeetingEmailBase extends EmailBase {
  meetingAt?: Date | string | null;
  timeZone?: string | null;
  meetingLink?: string | null;
  cancellationReason?: string | null;
  previousMeetingAt?: Date | string | null;
  previousTimeZone?: string | null;
  awaitingLink?: boolean | null;
  replyBody?: string | null;
}

function safeHttpsLink(value: string | null | undefined): string | null {
  return safeSupportMeetingLink(value);
}

function layout(title: string, bodyHtml: string, locale: SupportLocale): string {
  return `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,sans-serif;color:#1f2937;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#4f46e5;padding:24px 28px;color:#ffffff;">
      <div style="font-size:20px;font-weight:700;">${escapeSupportHtml(COPY[locale].brand)}</div>
      <div style="font-size:16px;margin-top:6px;">${escapeSupportHtml(title)}</div>
    </div>
    <div style="padding:28px;">${bodyHtml}</div>
    <div style="padding:18px 28px;background:#f9fafb;color:#6b7280;font-size:12px;">${escapeSupportHtml(COPY[locale].footer)}</div>
  </div>
</body></html>`;
}

function detailRows(locale: SupportLocale, rows: Array<[string, string | null | undefined]>): string {
  return `<table style="width:100%;border-collapse:collapse;margin:18px 0;">${rows
    .filter(([, value]) => Boolean(value))
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#6b7280;width:38%;">${escapeSupportHtml(label)}</td><td style="padding:8px 0;color:#111827;">${escapeSupportHtml(value)}</td></tr>`,
    )
    .join("")}</table>`;
}

function button(href: string, label: string): string {
  return `<div style="text-align:center;margin:22px 0;"><a href="${escapeSupportHtml(href)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${escapeSupportHtml(label)}</a></div>`;
}

function ticketDetails(copy: SupportEmailCopy, base: EmailBase): string {
  return detailRows(base.locale, [
    [copy.ticketLabel, base.ticketNumber],
    [copy.subjectLabel, base.subject],
    [copy.reasonLabel, base.reasonLabel],
  ]);
}

function meetingDetails(copy: SupportEmailCopy, base: MeetingEmailBase): string {
  return detailRows(base.locale, [
    [copy.timeLabel, formatSupportMeetingTime(base.meetingAt, base.timeZone, base.locale)],
    [copy.ticketLabel, base.ticketNumber],
    [copy.subjectLabel, base.subject],
    [copy.reasonLabel, base.reasonLabel],
  ]);
}

function meetingLinkDetails(copy: SupportEmailCopy, base: MeetingEmailBase): string {
  const link = safeHttpsLink(base.meetingLink);
  if (!link) return "";
  return detailRows(base.locale, [[copy.linkLabel, link]]);
}

export function renderSupportEmail(
  template: SupportEmailTemplateId,
  input: MeetingEmailBase,
): { subject: string; html: string; locale: SupportLocale } {
  const locale = input.locale;
  const copy = COPY[locale];
  const greeting = input.userName ? `<p>${escapeSupportHtml(copy.greeting(input.userName))}</p>` : "";
  const details = ticketDetails(copy, input);
  let title = copy.ackTitle;
  let subject = copy.ackTitle;
  let body = "";

  if (template === "support_ticket_ack") {
    body = `<p>${escapeSupportHtml(copy.ackIntro)}</p>${details}<p>${escapeSupportHtml(copy.ackBody)}</p>`;
  } else if (template === "support_meeting_ack") {
    body = `<p>${escapeSupportHtml(copy.meetingAckIntro)}</p>${meetingDetails(copy, input)}<p>${escapeSupportHtml(copy.meetingAckBody)}</p>`;
    subject = `${copy.ackTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
  } else if (template === "support_ticket_reply") {
    title = copy.replyTitle;
    subject = `${copy.replyTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
    body = `<p>${escapeSupportHtml(copy.replyIntro)}</p>${details}<div style="background:#f3f4f6;border-left:4px solid #4f46e5;padding:14px 16px;margin:16px 0;white-space:pre-wrap;">${escapeSupportHtml(input.replyBody || "")}</div>`;
  } else if (template === "support_meeting_confirmed") {
    title = copy.confirmedTitle;
    subject = `${copy.confirmedTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
    const link = safeHttpsLink(input.meetingLink);
    body = `<p>${escapeSupportHtml(copy.confirmedIntro)}</p>${meetingDetails(copy, input)}${meetingLinkDetails(copy, input)}${link ? button(link, copy.linkLabel) : ""}`;
  } else if (template === "support_meeting_link_updated") {
    title = copy.linkUpdatedTitle;
    subject = `${copy.linkUpdatedTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
    const link = safeHttpsLink(input.meetingLink);
    body = `<p>${escapeSupportHtml(copy.linkUpdatedIntro)}</p>${meetingDetails(copy, input)}${meetingLinkDetails(copy, input)}${link ? button(link, copy.linkLabel) : ""}`;
  } else if (template === "support_meeting_rescheduled") {
    title = copy.rescheduledTitle;
    subject = `${copy.rescheduledTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
    const link = safeHttpsLink(input.meetingLink);
    body = `<p>${escapeSupportHtml(copy.rescheduledIntro)}</p>${detailRows(locale, [
      [copy.previousTime, formatSupportMeetingTime(input.previousMeetingAt, input.previousTimeZone, locale)],
      [copy.newTime, formatSupportMeetingTime(input.meetingAt, input.timeZone, locale)],
      [copy.ticketLabel, input.ticketNumber],
      [copy.subjectLabel, input.subject],
    ])}${link ? meetingLinkDetails(copy, input) + button(link, copy.linkLabel) : input.awaitingLink ? `<p>${escapeSupportHtml(copy.linkPendingNote)}</p>` : ""}`;
  } else {
    title = copy.cancelledTitle;
    subject = `${copy.cancelledTitle}${input.ticketNumber ? ` - ${input.ticketNumber}` : ""}`;
    body = `<p>${escapeSupportHtml(copy.cancelledIntro)}</p>${detailRows(locale, [
      [copy.timeLabel, formatSupportMeetingTime(input.meetingAt, input.timeZone, locale)],
      [copy.ticketLabel, input.ticketNumber],
      [copy.subjectLabel, input.subject],
      [copy.cancellationReasonLabel, input.cancellationReason],
    ])}`;
  }

  return {
    locale,
    subject,
    html: layout(title, `${greeting}${body}`, locale),
  };
}
