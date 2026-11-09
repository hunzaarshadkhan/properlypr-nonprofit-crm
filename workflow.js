import { offsets, sourceDay, workday } from "./cadence.js";
const sequence = [
  "Email 1",
  "Call 1",
  "Email 2",
  "Call 2",
  "Email 3",
  "Call 3",
  "Email 4",
];
export function todayET(time = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
}
function dayPlus(day, count, business = false) {
  const dt = new Date(day + "T12:00:00Z");
  for (let i = 0; i < count; ) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    if (!business || ![0, 6].includes(dt.getUTCDay())) i++;
  }
  while ([0, 6].includes(dt.getUTCDay())) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
const stopped = ["Do not contact", "Archived", "Won", "Lost"];
export function actions(o) {
  if (stopped.includes(o.status)) return [];
  const shared = [
    "Meeting booked",
    "Email requested",
    "Callback requested",
    "Not interested",
    "Wrong number",
    "Dial failed",
    "Do not contact",
  ];
  if (["Rebooking", "Nurture follow-up"].includes(o.status))
    return [
      o.step.startsWith("Follow-up email")
        ? "Follow-up email sent"
        : "Follow-up call done",
      ...shared,
    ];
  if (o.tab === "Meetings") {
    if (o.status === "Meeting held")
      return [
        "Proposal sent",
        "Won",
        "Lost",
        "Not interested",
        "Do not contact",
      ];
    if (o.status === "Proposal sent")
      return ["Won", "Lost", "Callback requested", "Do not contact"];
    const reminder = {
      "Confirm meeting": "Invite sent",
      "Confirmation call": "Confirmation call done",
      "Joining reminder": "Joining reminder sent",
    }[o.step];
    return [
      ...(reminder ? [reminder] : []),
      "Set meeting time",
      "Meeting held",
      "No-show",
      "Cancelled",
      "Do not contact",
    ];
  }
  if (o.tab === "Available") return ["Add to first calls"];
  if (o.tab === "Review and Nurture")
    return [
      o.status === "Nurture"
        ? "Start nurture follow-up"
        : "Return to first calls",
      ...shared,
      "Archive",
    ];
  if (o.tab === "Email Sequence")
    return [
      o.step?.startsWith("Email") ? "Email sent" : "Call done",
      ...shared.filter((v) => v !== "Email requested"),
    ];
  if (
    o.tab === "Callbacks" ||
    o.tab === "Cold Call Sequence" ||
    o.tab === "First call"
  )
    return ["No answer", "Not connected", "Voicemail", "Busy", ...shared];
  return ["Return to first calls", "Archive", "Do not contact"];
}
export function transition(org, action, day, at) {
  if (!actions(org).includes(action))
    throw Error("This action is unavailable at the current stage.");
  const o = { ...org };
  const place = (tab, status, step, due = "") =>
    Object.assign(o, { tab, status, step, due });
  const review = (step = "Review completed sequence") =>
    place("Review and Nurture", "Review", step);
  const nurture = () =>
    place("Review and Nurture", "Nurture", "Review nurture", dayPlus(day, 90));
  const scheduled = ["Set meeting time", "Callback requested"];
  if (
    at &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ||
      !Number.isFinite(Date.parse(at)))
  )
    throw Error("Choose a valid Eastern date and time.");
  if (scheduled.includes(action) && !at)
    throw Error("Enter the agreed Eastern date and time.");
  if (action === "Add to first calls" || action === "Return to first calls")
    place("First call", "Awaiting first call", "Make first call", day);
  else if (action === "Meeting booked" || action === "Set meeting time") {
    o.agreed = at || "";
    o.bookedDay = day;
    place(
      "Meetings",
      "Booked",
      at ? "Confirm meeting" : "Enter meeting time",
      at ? day : "",
    );
  } else if (
    ["Invite sent", "Confirmation call done", "Joining reminder sent"].includes(
      action,
    )
  ) {
    if (o.due && day < o.due)
      throw Error("This reminder is due on " + o.due + ".");
    const meeting = sourceDay(o.agreed),
      prior = workday(meeting, -1);
    if (action === "Invite sent" && day <= prior && o.bookedDay < prior)
      place("Meetings", "Booked", "Confirmation call", prior);
    else if (action !== "Joining reminder sent" && day <= meeting)
      place("Meetings", "Booked", "Joining reminder", meeting);
    else place("Meetings", "Booked", "Record meeting outcome", meeting);
  } else if (action === "Meeting held")
    place("Meetings", "Meeting held", "Record decision");
  else if (action === "Proposal sent")
    place("Meetings", "Proposal sent", "Record decision");
  else if (action === "Won" || action === "Lost")
    place("Meetings", action, "Closed");
  else if (
    action === "No-show" ||
    action === "Cancelled" ||
    action === "Start nurture follow-up"
  ) {
    if (action === "Start nurture follow-up" && o.due && day < o.due)
      throw Error("The nurture review is due on " + o.due + ".");
    o.agreed = "";
    o.followStart = "";
    const missed = action !== "Start nurture follow-up";
    place(
      missed ? "Meetings" : "Review and Nurture",
      missed ? "Rebooking" : "Nurture follow-up",
      "Follow-up email 1",
      workday(day, 0),
    );
  } else if (
    action === "Follow-up email sent" ||
    action === "Follow-up call done"
  ) {
    if (o.due && day < o.due)
      throw Error("This follow-up is due on " + o.due + ".");
    if (action === "Follow-up email sent" && !o.email)
      throw Error("Add the recipient’s email before logging a send.");
    const n = sequence.findIndex(
      (s) => "Follow-up " + s.toLowerCase() === o.step,
    );
    if (n < 0) throw Error("Unknown follow-up step.");
    o.followStart = o.followStart || day;
    if (n === 6) nurture();
    else
      place(
        o.tab,
        o.status,
        "Follow-up " + sequence[n + 1].toLowerCase(),
        workday(o.followStart, offsets[n + 1]),
      );
  } else if (action === "Email requested") {
    place("Email Sequence", "Information", "Email 1", dayPlus(day, 0));
    o.emailStart = "";
  } else if (action === "Email sent" || action === "Call done") {
    if (o.due && day < o.due)
      throw Error("This follow-up is scheduled for " + o.due + ".");
    if (
      action === "Email sent" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email || "")
    )
      throw Error(
        "Add the recipient’s email in the profile before logging a send.",
      );
    const n = sequence.indexOf(o.step);
    if (n < 0) throw Error("Review this sequence step.");
    o.emailStart = o.emailStart || day;
    if (n === 6) review("Date nurture");
    else
      place(
        "Email Sequence",
        "Information",
        sequence[n + 1],
        workday(o.emailStart, offsets[n + 1]),
      );
  } else if (action === "Callback requested") {
    o.agreed = at;
    o.callbackAttempts = 0;
    o.callbackStart = "";
    place("Callbacks", "Callback", "Callback 1", at.slice(0, 10));
  } else if (["No answer", "Not connected", "Voicemail", "Busy"].includes(action)) {
    if (o.tab !== "First call" && o.due && day < o.due)
      throw Error("This call is due on " + o.due + ".");
    if (o.tab === "Callbacks") {
      const attempt = Number(o.step.match(/\d+/)?.[0] || 1);
      o.callbackAttempts = attempt;
      if (attempt >= 3) {
        if (/^yes$/i.test(o.allowed) && o.email)
          place(
            "Email Sequence",
            "Information",
            "Email 1",
            dayPlus(day, 1, true),
          );
        else nurture();
      } else {
        o.callbackStart = o.callbackStart || day;
        place(
          "Callbacks",
          "Callback",
          "Callback " + (attempt + 1),
          [workday(day, 1), workday(o.callbackStart, attempt === 1 ? 3 : 7)]
            .sort()
            .at(-1),
        );
      }
    } else {
      const attempt =
        o.tab === "First call" ? 1 : Number(o.step.match(/\d+/)?.[0] || 1);
      const first =
        attempt === 1
          ? day
          : o.coldStart ||
            sourceDay(o.history.find((h) => h.text === "No answer")?.date) ||
            day;
      o.coldStart = first;
      if (attempt >= 3) review("Review after three calls");
      else
        place(
          "Cold Call Sequence",
          "Cold calls",
          "Cold call " + (attempt + 1),
          [workday(day, 1), workday(first, attempt === 1 ? 2 : 5)]
            .sort()
            .at(-1),
        );
    }
  } else if (action === "Not interested") nurture();
  else if (action === "Wrong number" || action === "Dial failed")
    place(
      "Review and Nurture",
      "Contact review",
      "Verify number or dialer",
      workday(day, 1),
    );
  else if (action === "Do not contact")
    place("Review and Nurture", "Do not contact", "Stopped");
  else if (action === "Archive")
    place("Review and Nurture", "Archived", "Stopped");
  return o;
}
