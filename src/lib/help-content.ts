/*
 * ============================================================
 * PORTAL GUIDANCE CONTENT
 *
 * The user-facing help content shown by the Portal Guidance
 * panel (src/components/help/ContextualHelp.tsx).
 *
 * Every workflow described here was verified against the
 * current application implementation. Articles use plain
 * language for end users — no technical internals.
 * ============================================================
 */

export type HelpRole =
  | "all"
  | "admin"
  | "election_officer"
  | "campaign_member"
  | "social_member";

export interface HelpRelatedLink {
  label: string;
  href: string;
}

export interface HelpArticle {
  id: string;
  title: string;
  category: string;
  /** Which members this article is most relevant to. */
  roles: HelpRole[];
  /** Extra words that should match when searching. */
  keywords?: string[];
  /** Plain-language paragraphs. */
  body: string[];
  /** Optional numbered how-to steps. */
  steps?: string[];
  /** Optional links into the portal. */
  related?: HelpRelatedLink[];
}

export interface HelpCategory {
  id: string;
  title: string;
  description: string;
}

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    description: "What the portal is and how to move around it.",
  },
  {
    id: "account",
    title: "Your Account",
    description: "Membership, profile, and notifications.",
  },
  {
    id: "roles-scope",
    title: "Roles & Scope",
    description: "Who can do what, and how location affects it.",
  },
  {
    id: "campaign",
    title: "Campaign Council",
    description: "Members, areas, assignments, activities, reports and issues.",
  },
  {
    id: "tasks-points",
    title: "Tasks & Leaderboard",
    description: "Social tasks, points and rankings.",
  },
  {
    id: "election",
    title: "Election Operations",
    description: "Cycles, contests, results, reports and incidents.",
  },
  {
    id: "administration",
    title: "Administration",
    description: "Tools for administrators.",
  },
  {
    id: "troubleshooting",
    title: "Why can't I…?",
    description: "Common questions about access and workflow.",
  },
];

export const HELP_ARTICLES: HelpArticle[] = [
  /* ----------------------------------------------------------
   * GETTING STARTED
   * ---------------------------------------------------------- */
  {
    id: "what-is-the-portal",
    title: "What is the PolitiCore Portal?",
    category: "getting-started",
    roles: ["all"],
    keywords: ["introduction", "start", "about"],
    body: [
      "The PolitiCore Portal is the campaign headquarters app for the Ifeanyi 2027 campaign. It brings the campaign's day-to-day work into one place: connecting with supporters, running social media tasks, organising activities on the ground, reporting from polling units, and managing election results.",
      "What you can do inside the portal depends on your membership and role. Some people use it mainly for social engagement, others coordinate campaign work across the State, Zone, LGA, Ward and Polling Unit levels, and a small group administers the whole system.",
      "Use the menu on the left to move around. If a menu item isn't shown for you, it usually means it belongs to a part of the campaign you don't work in.",
    ],
  },
  {
    id: "signing-in-and-out",
    title: "Signing in and signing out",
    category: "getting-started",
    roles: ["all"],
    keywords: ["login", "password", "session", "logout"],
    body: [
      "You sign in with the email address and password for your campaign account. Accounts are created for you by an administrator — there is no self-service sign-up inside the portal (supporters can use the public Volunteer page instead).",
      "If your session expires while you work, you'll be asked to sign in again. This is normal security behaviour — simply sign in and continue.",
      "When you finish, use the sign-out control in the sidebar. If signing out fails, you'll see a brief message asking you to try again.",
    ],
    steps: [
      "Go to the sign-in page and enter your email address and password.",
      "If you see a message that the details are incorrect, check for typing errors first.",
      "If you have forgotten your password or can't get in, contact a campaign administrator to have your access checked or your password reset.",
    ],
  },
  {
    id: "understanding-the-dashboard",
    title: "Understanding your dashboard",
    category: "getting-started",
    roles: ["all"],
    keywords: ["home", "overview", "bell"],
    body: [
      "Your dashboard is the first page you see after signing in. It summarises the parts of the campaign that apply to you and gives you quick links into them.",
      "The bell icon at the top of the portal is your Notification Center. It keeps a history of messages addressed to you — things like announcements and updates about your work. It is different from the small confirmation pop-ups that appear when you save or submit something; those disappear after a few seconds and are not stored in the bell.",
    ],
  },
  {
    id: "navigation-and-menus",
    title: "Menus and why they differ between people",
    category: "getting-started",
    roles: ["all"],
    keywords: ["sidebar", "menu", "navigation", "missing"],
    body: [
      "The sidebar is grouped into areas: your everyday tools (Dashboard, Profile, Tasks), the Campaign Council for ground work, Election Operations during election periods, and — for administrators — the Admin section.",
      "You only see the groups and pages that your role and membership allow. For example, Election Operations is hidden from social-only members, and the Admin section is only shown to administrators.",
      "If a colleague has a menu you don't, it's not a fault — it reflects what each of you works on. If you believe you should have access to an area, ask an administrator.",
    ],
  },

  /* ----------------------------------------------------------
   * YOUR ACCOUNT
   * ---------------------------------------------------------- */
  {
    id: "membership-types",
    title: "Membership types: Social and Campaign",
    category: "account",
    roles: ["all"],
    keywords: ["social_member", "campaign_member", "dual"],
    body: [
      "Every account has one or two membership types. Social membership is for engaging with the campaign's public content — tasks, points and the leaderboard. Campaign membership is for organised ground work: areas, assignments, activities, reports and election duties.",
      "You can hold both types at once, and many people do. A member with both types uses the portal as a full campaign member; holding social membership never removes campaign abilities.",
      "Membership type is controlled by administrators. If your type doesn't match the work you actually do, ask an administrator to review it.",
    ],
  },
  {
    id: "your-profile",
    title: "Your profile",
    category: "account",
    roles: ["all"],
    keywords: ["profile", "phone", "name", "change details"],
    body: [
      "The Profile page shows the details held about you: your full name, phone number, gender, your membership types, and your registered location (council area, ward and polling unit).",
      "Profile details are maintained by administrators to keep the member register accurate. You can't edit them from the portal — if something is wrong (for example a misspelled name or the wrong polling unit), contact an administrator and ask for it to be corrected.",
    ],
  },
  {
    id: "notification-center-vs-popups",
    title: "The bell (Notification Center) vs. confirmation pop-ups",
    category: "account",
    roles: ["all"],
    keywords: ["toast", "notification", "bell", "alerts"],
    body: [
      "There are two different kinds of messages in the portal, and it helps to know the difference.",
      "The Notification Center (the bell) keeps a persistent history of messages addressed to you — announcements and workflow updates you may want to re-read later.",
      "Confirmation pop-ups appear briefly after you perform an action: “Saved successfully”, “Submission received”, “You don't have permission to do that”, and so on. They tell you how the action you just performed went, then disappear on their own. They are not stored anywhere — that's what the bell is for.",
    ],
  },

  /* ----------------------------------------------------------
   * ROLES & SCOPE
   * ---------------------------------------------------------- */
  {
    id: "roles-explained",
    title: "Roles explained",
    category: "roles-scope",
    roles: ["all"],
    keywords: ["admin", "officer", "role", "coordinator", "authority"],
    body: [
      "There are four kinds of people in the portal:",
      "Social Members engage with public content and social tasks. Campaign Members do organised campaign work on the ground. Election Officers run election-day operations — reviewing results, reports and incidents for the whole campaign. Administrators manage the system itself: members, content, configuration and records.",
      "Separately from these roles, some people hold an organisational position such as Ward Coordinator, LGA Coordinator, Zone Coordinator, State Coordinator, Campaign Manager or Council Chairman. A position describes where someone works and what they coordinate — it is not itself a system role. Two Ward Coordinators could have different memberships and therefore different menus.",
    ],
  },
  {
    id: "organizational-scope",
    title: "Organisational scope: State, Zone, LGA, Ward, Polling Unit",
    category: "roles-scope",
    roles: ["all"],
    keywords: ["hierarchy", "ward", "lga", "polling unit", "area", "visibility"],
    body: [
      "The campaign is organised geographically in layers: State → Zone → LGA (council) → Ward → Polling Unit.",
      "Your account is registered at a specific ward and polling unit. Many election features — submitting results, filing polling-unit reports and incidents — operate for the polling unit where you are registered. That is why you may be able to report for your own polling unit but not for another one.",
      "Your organisational assignment can extend your working area: a Ward Coordinator works across their ward, an LGA Coordinator across the council, and so on up the hierarchy. The wider your assignment, the more you can see and act on.",
      "Administrators and Election Officers can see and act across the whole campaign — that's why an administrator can view information (such as members or donations) that is invisible to a ward-level member.",
    ],
  },
  {
    id: "access-denied",
    title: "What to do when you can't access something",
    category: "roles-scope",
    roles: ["all"],
    keywords: ["permission", "denied", "blocked", "no access"],
    body: [
      "If you try to open a page you're not permitted to use, you'll see a message telling you access is restricted, or you'll be redirected back with a brief explanation.",
      "First check that you're signed in with your own account — access is personal to each member. Then consider whether the page belongs to another area: election pages, for instance, are only for campaign members and election staff, not social-only members.",
      "If you believe you should have access, contact an administrator. They can check your membership, role, organisational assignment and any special permissions that may have been granted to you.",
    ],
  },

  /* ----------------------------------------------------------
   * CAMPAIGN COUNCIL
   * ---------------------------------------------------------- */
  {
    id: "campaign-council-overview",
    title: "The Campaign Council",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["ground work", "overview"],
    body: [
      "The Campaign Council is where ground work happens: viewing your area, contacting fellow members, working with assignments, organising activities, and reporting issues and progress from the field.",
      "The council area only appears for campaign members and administrators. Each page inside it may show more or less information depending on your organisational scope — a ward-level member sees their ward; a council coordinator sees more.",
    ],
  },
  {
    id: "my-area",
    title: "My Area",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["area operations", "geography"],
    body: [
      "My Area shows the campaign structure around you — the hierarchy from your position outward, and the people operating in your area.",
      "Use it to understand where you fit in the campaign geography and who coordinates the areas around you. What you can see here grows with your organisational assignment.",
    ],
  },
  {
    id: "member-directory",
    title: "The member directory",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["members", "contacts", "lifecycle", "suspended"],
    body: [
      "The Members page is a directory of campaign members. How much of it you can see depends on your scope — coordinators see the members in their area, administrators see everyone.",
      "Administrators manage the full member lifecycle here: adding new members (with their location and memberships), updating details, and setting a member's status to active, suspended or deactivated. A suspended or deactivated member can no longer use the portal.",
      "If your own details are wrong, see “Your profile” — corrections go through an administrator.",
    ],
  },
  {
    id: "assignments",
    title: "Assignments",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["duties", "tasks on the ground"],
    body: [
      "Assignments are pieces of ground work given to members — for example covering a location or a duty during an activity. Assignments can be created and updated by those with authority, and the member assigned can see and work on theirs.",
      "When an assignment is created, updated or removed, everyone involved sees a brief confirmation, and the change is visible on the Assignments page.",
    ],
  },
  {
    id: "activities",
    title: "Campaign activities",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["events", "rsvp", "attendance", "check in"],
    body: [
      "Activities are scheduled campaign events on the ground — meetings, rallies, outreach and similar. Each activity moves through a life of scheduled → ongoing → completed, and can be cancelled if plans change.",
      "Members can indicate attendance (Going, Interested, or Not Going) and are checked in and out on the day so attendance is recorded.",
      "Creating and managing activities is done by administrators and campaign staff; regular members participate and respond. If an activity you're attending is cancelled, its status will show as cancelled.",
    ],
  },
  {
    id: "field-reports",
    title: "Field reports",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["report", "submit", "review"],
    body: [
      "Field reports let members on the ground send structured updates about their work and what they observe, including evidence links where relevant.",
      "After you submit a report it goes to campaign staff for review. Staff with review authority read reports and act on them — a report is a two-way workflow, not just a message. You can always file another report if the situation changes.",
    ],
  },
  {
    id: "issues",
    title: "Issues",
    category: "campaign",
    roles: ["campaign_member", "admin"],
    keywords: ["problem", "escalate", "logistics", "security", "priority"],
    body: [
      "Issues are problems that need the campaign's attention: logistics, a campaign activity, a community concern, volunteer matters, communication, security, infrastructure, or anything else that doesn't fit those types.",
      "When you raise an issue you give it a priority (low, medium, high or urgent) and can attach an evidence link. It then moves through a visible lifecycle: reported → acknowledged → assigned → in progress → resolved → closed. You can follow the status to see that your issue is being handled, and staff can assign it to someone and record resolution notes.",
      "Urgent and security issues should also be escalated directly to your coordinator — the portal is a record, not an emergency channel.",
    ],
  },

  /* ----------------------------------------------------------
   * TASKS & LEADERBOARD
   * ---------------------------------------------------------- */
  {
    id: "social-tasks",
    title: "Social tasks and points",
    category: "tasks-points",
    roles: ["all"],
    keywords: ["task", "points", "proof", "submit", "like", "share"],
    body: [
      "Social tasks are quick engagement actions for the campaign's public content — for example liking, sharing or commenting on a post. Each task describes exactly what to do.",
      "Some tasks ask for a link as proof (the task will tell you when one is needed); if a proof link is required, you can't submit without it. You can only submit each task once, so make sure your work is done before submitting.",
      "After you submit, an administrator checks the submission. When it's verified, your points are awarded. If something goes wrong while submitting you'll see a clear message — try again, and if it keeps failing, contact an administrator.",
    ],
    related: [{ label: "Open Tasks", href: "/portal/tasks" }],
  },
  {
    id: "leaderboard",
    title: "The leaderboard",
    category: "tasks-points",
    roles: ["all"],
    keywords: ["ranking", "top", "points", "position"],
    body: [
      "The leaderboard ranks members by the social points they have earned from verified tasks. It's a friendly competition — the more tasks you complete and get verified, the higher you climb.",
      "Points only come from verified task completions, so if you've just submitted a task, give an administrator time to verify it before expecting movement.",
      "The list shows the top members along with their points. Your own standing improves as your verified work adds up — there's nothing to configure.",
    ],
    related: [{ label: "Open Leaderboard", href: "/portal/leaderboard" }],
  },

  /* ----------------------------------------------------------
   * ELECTION OPERATIONS
   * ---------------------------------------------------------- */
  {
    id: "election-concepts",
    title: "Election concepts: cycles, contests and settings",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["cycle", "contest", "presidential", "governorship", "senatorial"],
    body: [
      "An election in PolitiCore is not one single event — it's a set of contests that happen together. An Election Cycle is the overall period (for example, the 2027 general elections) and holds the individual contests inside it.",
      "Each contest is a specific race: Presidential, Governorship, Senatorial, House of Representatives, or State House of Assembly. A contest also has a geographic scope — national, state, senatorial zone, federal constituency or state constituency — which decides which polling units it covers.",
      "Cycles and contests are prepared in advance by administrators and move through statuses: a cycle can be draft, scheduled, active, paused, closed or archived; a contest can be draft, open, paused or closed. You submit and read results for contests that are open within the active cycle.",
      "Election settings control how collation behaves during the period. Members don't configure anything here — this page just helps you understand what you're looking at.",
    ],
  },
  {
    id: "election-dashboard",
    title: "The Election Dashboard",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["overview", "current contest"],
    body: [
      "The Election Dashboard is the front page of election work. It shows the current election picture — the active cycle and its contests — and is the jumping-off point for result upload, polling-unit reports and incidents.",
      "It's available to campaign members, election officers and administrators. Social-only members don't have election access and won't see this area at all.",
      "If the dashboard says there are no open contests, election activity isn't open for submissions yet — wait for administrators to open the relevant contest.",
    ],
    related: [{ label: "Open Election Dashboard", href: "/portal/election" }],
  },
  {
    id: "result-upload",
    title: "Submitting a polling unit result",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["upload", "ec8", "submit result", "votes"],
    body: [
      "Result submission happens at your registered polling unit. You record the official count from your unit for an open contest and attach a clear photo of the result sheet (Form EC8) as evidence.",
      "A result can only be submitted for a polling unit that is within the contest's geographic scope — your own registered unit, or a unit you've been given authority over. If you pick a contest that doesn't cover your unit, the portal will tell you.",
      "Take the evidence photo carefully: the sheet should be readable, straight and fully in frame. Officers verify submissions against this photo, so evidence quality decides how fast your result is approved.",
    ],
    steps: [
      "Open Result Upload from the Election Operations menu.",
      "Select the active cycle, the contest, and your polling unit.",
      "Enter the vote counts for each party exactly as on the result sheet.",
      "Attach a clear photo of the signed result sheet (Form EC8).",
      "Submit — you'll see a confirmation that your result was received and is awaiting review.",
    ],
    related: [{ label: "Open Result Upload", href: "/portal/election/upload" }],
  },
  {
    id: "result-statuses",
    title: "What each result status means",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["pending", "approved", "rejected", "clarification", "reopened"],
    body: [
      "Every submitted result carries a status so you always know where it stands:",
      "Submitted — your result has been received and is waiting to be reviewed.",
      "Pending review — an officer has picked it up and is checking the figures against the evidence photo.",
      "Approved — the result was verified as correct. Approved results count towards official totals and dashboards.",
      "Rejected — the result was not accepted (for example, the evidence doesn't support the figures). The review notes explain why; where the process allows, a corrected result can be submitted.",
      "Clarification required — the officer needs more information before deciding. Read the review notes and respond or resubmit as instructed.",
      "Reopened — a result that had been approved has been opened again for another look, usually after a correction or a dispute. Its fate is decided by the same review process.",
      "You can't change a result's status yourself — only Election Officers (and administrators, through corrections) move results through the workflow.",
    ],
  },
  {
    id: "officer-review",
    title: "The officer review desk (Election Officers)",
    category: "election",
    roles: ["election_officer", "admin"],
    keywords: ["verify", "approve", "reject", "clarify", "reopen"],
    body: [
      "The Officer Operations Desk is the review queue for submitted results. Election Officers see incoming submissions for the campaign and decide each one, with an audit trail kept on every result.",
      "When reviewing, open the result, compare the entered figures against the attached evidence photo, and choose an action: approve, reject, ask for clarification, or reopen. Rejecting or asking for clarification requires review notes — say clearly what's wrong or what you need.",
      "Approval is what makes a result count officially. Take the evidence seriously: approve only what the photo supports.",
    ],
    related: [
      { label: "Open Officer Operations Desk", href: "/portal/election/operations" },
    ],
  },
  {
    id: "result-corrections",
    title: "Correcting a result (administrators)",
    category: "election",
    roles: ["admin"],
    keywords: ["correct", "fix", "amend", "verified"],
    body: [
      "If an error is discovered in an approved result, administrators can correct it from the election administration page. The corrected figures are recorded, and the result's history shows every change made, by whom, and when.",
      "Corrections never silently overwrite history — the previous figures and the correction remain visible on the result's audit trail, which protects everyone involved.",
      "Regular members and officers can't correct approved results; if you believe a verified result is wrong, report it to an administrator.",
    ],
  },
  {
    id: "pu-reports",
    title: "Polling unit reports",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["pu report", "opening", "closing", "setup", "counting"],
    body: [
      "Polling unit (PU) reports record how a polling unit is running on election day — for example, opening and setup in the morning, and closing and counting at the end. They give the campaign a live picture of every unit.",
      "You submit reports for your registered polling unit (or a unit you have authority over). Give the concrete details requested — officers and administrators rely on these reports to spot where support is needed.",
      "After submission, Election Officers and administrators can see reports across the campaign; other members only see the ones for their own area. If you make a mistake, submit a corrected report and, if it's serious, alert your coordinator or an officer.",
    ],
    related: [{ label: "Open PU Reports", href: "/portal/election/pu-reports" }],
  },
  {
    id: "election-incidents",
    title: "Election incidents",
    category: "election",
    roles: ["campaign_member", "election_officer", "admin"],
    keywords: ["incident", "problem", "report", "evidence"],
    body: [
      "Incidents are for reporting problems observed at a polling unit during an election — anything that affects the process, your agents, or the campaign's ability to operate.",
      "File an incident with the incident type, a clear description of what happened, and evidence (a photo or link) if you have it. Incidents are submitted for your registered polling unit or one you have authority over.",
      "Election Officers and administrators review incidents across the campaign and decide what action to take. For anything dangerous or urgent, contact the authorities and your coordinator first — the portal record supports the response, it doesn't replace it.",
    ],
    related: [{ label: "Open Incidents", href: "/portal/election/incidents" }],
  },

  /* ----------------------------------------------------------
   * ADMINISTRATION
   * ---------------------------------------------------------- */
  {
    id: "admin-overview",
    title: "The administrator's toolkit",
    category: "administration",
    roles: ["admin"],
    keywords: ["admin", "dashboard", "tools"],
    body: [
      "The Admin section is only visible to administrators. It covers member management, task management, the donation ledger, public content (news, manifesto, gallery, biography, broadcast), campaign analytics, audit logs, system health, coordination of assignments and permissions, and election configuration.",
      "Most admin actions affect what other members see, so changes are worth double-checking before saving — especially publishing content and configuring elections.",
    ],
  },
  {
    id: "manage-members",
    title: "Adding and managing members",
    category: "administration",
    roles: ["admin"],
    keywords: ["add member", "account", "suspend", "deactivate"],
    body: [
      "Administrators create member accounts with the member's email, name, phone, location (council, ward, polling unit), membership types, access role and optional social media handles. The member signs in with the credentials that were set up.",
      "The member directory also manages lifecycle: members can be active, suspended or deactivated. Suspension or deactivation removes their access to the portal until an administrator restores it.",
      "Keep locations accurate — a member's registered ward and polling unit decide which election duties they can perform.",
    ],
  },
  {
    id: "coordination",
    title: "Coordination: assignments and permission grants",
    category: "administration",
    roles: ["admin"],
    keywords: ["organizational assignment", "coordinator", "grant", "scope"],
    body: [
      "The Coordination page answers the question “where does this person operate?”. It's where organisational assignments are created, updated and removed — placing members at ward, council, zone or state level.",
      "Coordination is also where special permission grants are given: an explicit permission that lets a specific member do or see something beyond their normal scope, such as viewing polling-unit reports across a wider area.",
      "Use grants sparingly and remove them when no longer needed — they're a precise tool, not a substitute for the right membership and assignment.",
    ],
    related: [{ label: "Open Coordination", href: "/portal/campaign/coordination" }],
  },
  {
    id: "election-administration",
    title: "Configuring elections (administrators)",
    category: "administration",
    roles: ["admin"],
    keywords: ["cycle", "contest", "candidates", "settings", "configuration"],
    body: [
      "Election configuration is done in the admin election area: create the election cycle, add each contest (presidential, governorship, senatorial, House of Representatives, State House of Assembly) with its geographic scope, register candidates and parties, and manage election settings.",
      "A contest must be open within an active cycle before members can submit results, reports and incidents for it. Statuses let you control the sequence: draft while preparing, open during voting, paused or closed when needed.",
      "This is also where result corrections happen when a verified result needs fixing — see “Correcting a result”.",
    ],
    related: [{ label: "Open Election Administration", href: "/portal/admin/election" }],
  },
  {
    id: "task-management",
    title: "Task management (administrators)",
    category: "administration",
    roles: ["admin"],
    keywords: ["create task", "verify submission", "award points"],
    body: [
      "The Task Manager is where social tasks are created and maintained: title, description, the action required, any guidelines for volunteers, and the points value. Tasks can be deactivated when they should no longer be picked up, and reactivated later.",
      "Members' completions arrive as submissions. Review each one and mark it verified when the member genuinely did the task — verification is what awards the points. A submission can also be marked unverified again if it was awarded in error.",
      "Clear task descriptions and guidelines mean fewer rejected submissions and less back-and-forth.",
    ],
  },
  {
    id: "donation-ledger",
    title: "The donation ledger (private, administrators only)",
    category: "administration",
    roles: ["admin"],
    keywords: ["donations", "ledger", "finance", "pledged", "received"],
    body: [
      "The donation ledger is a private, administrators-only record of contributions received directly by the candidate and campaign. It is an audit and analytics ledger — money is not collected through this application, and no member can donate through the portal.",
      "When recording a donation you capture: the donor's name and contact details, the amount and date received, how it arrived (cash, bank transfer, POS, cheque or other), its purpose category (for example campaign fund, event sponsorship or logistics), the council or ward it's associated with, any external receipt or reference number, and notes.",
      "A donation is recorded as received, pledged or cancelled. The page provides summaries and totals, searching and filtering, and every record keeps an audit history of who created or changed it and when — treat the ledger as a formal financial record.",
    ],
    related: [{ label: "Open Donation Records Ledger", href: "/portal/admin/donations" }],
  },
  {
    id: "public-content",
    title: "Public content: news, biography, manifesto, gallery, broadcast",
    category: "administration",
    roles: ["admin"],
    keywords: ["cms", "publish", "unpublish", "draft", "announcement", "events"],
    body: [
      "The public website draws its content from the portal. Administrators manage it in the Admin section:",
      "News — write campaign news with images, categories and excerpts. An article can be a draft (not public), published (visible on the site), scheduled (publishes later) or archived (withdrawn).",
      "Biography, Manifesto and Gallery — each is a simple editor where content is prepared as a draft and then published to the public site. Unpublishing hides it again.",
      "Broadcast (Announcements & Events) — announcements are composed in the portal and delivered to chosen audiences: all members, campaign members, social members or election officers. They arrive in members' Notification Center, not as pop-ups.",
      "Publishing is a public act — review spelling, images and facts before you publish.",
    ],
  },
  {
    id: "contact-messages",
    title: "Contact messages",
    category: "administration",
    roles: ["admin"],
    keywords: ["contact form", "inbox", "public"],
    body: [
      "Messages sent through the public Contact page arrive in the Contact Messages page. Read them here and follow up outside the portal using the contact details the sender provided.",
      "This is the campaign's public inbox — check it regularly so public enquiries aren't missed.",
    ],
  },
  {
    id: "audit-logs",
    title: "Audit logs and system health",
    category: "administration",
    roles: ["admin"],
    keywords: ["audit", "history", "health", "checks"],
    body: [
      "Audit logs record sensitive activity across the system — including donation ledger changes and election configuration — showing what was done, by whom and when. Use them when you need to answer “who changed this?”.",
      "System Health runs checks on the portal's critical parts, including the election module, and highlights anything that needs attention. If something in the portal seems broken, check here first.",
    ],
  },
  {
    id: "campaign-analytics",
    title: "Campaign analytics and reports",
    category: "administration",
    roles: ["admin"],
    keywords: ["reports", "analytics", "totals", "numbers"],
    body: [
      "The admin Reports page brings campaign numbers together — activity across the ground game and election data — so leadership can see progress at a glance.",
      "Figures here reflect records in the portal. If a number looks wrong, trace it to the underlying records (for example, unverified results or recent submissions) before treating it as official.",
    ],
    related: [{ label: "Open Campaign Analytics & Reports", href: "/portal/admin/reports" }],
  },

  /* ----------------------------------------------------------
   * TROUBLESHOOTING
   * ---------------------------------------------------------- */
  {
    id: "why-no-election-menu",
    title: "“I cannot see Election.”",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["election missing", "hidden", "social only"],
    body: [
      "Election Operations only appears for campaign members, election officers and administrators. Social-only members deliberately have no election access — election menus, dashboards and pages are hidden, and direct links to them won't open.",
      "If you do campaign work on the ground but can't see election menus, your membership type may be set to social only. Ask an administrator to review your membership so it includes campaign membership, and make sure your ward and polling unit are registered — result submission and polling-unit reporting work off your registered location.",
    ],
  },
  {
    id: "why-cannot-perform-action",
    title: "“I can see a page but can't do something on it.”",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["permission denied", "read only", "button disabled"],
    body: [
      "Seeing a page and being allowed to change things are two different permissions. Many pages are readable to a wide group but editable only by specific roles — for example, anyone in the election workflow can see results, but only officers verify them and only administrators correct approved ones.",
      "If an action fails with a permission message, it isn't a glitch: the system is telling you this step belongs to another role. The page itself or this guide will usually say who performs the action.",
      "If you've been given a duty that needs a permission you don't have, an administrator can grant it on the Coordination page.",
    ],
  },
  {
    id: "why-not-another-ward",
    title: "“I can see my ward but not another ward.”",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["scope", "ward", "polling unit", "geography"],
    body: [
      "Election reporting is anchored to geography. Your account is registered at one ward and polling unit, and that is where you report results, polling-unit reports and incidents. Other areas belong to the members registered there.",
      "Wider visibility comes from organisational assignments (coordinators see their area) or an explicit permission grant. Election Officers and administrators work across the whole campaign, which is why they can see what you can't.",
      "If your registration itself is wrong — you've been registered at the wrong unit — an administrator needs to correct your profile.",
    ],
  },
  {
    id: "result-status-changed",
    title: "“My result's status changed.”",
    category: "troubleshooting",
    roles: ["campaign_member", "election_officer"],
    keywords: ["status", "review", "rejected", "approved"],
    body: [
      "Results move through review on purpose. After you submit, an election officer checks your figures against the evidence photo. The status then changes to approved, rejected, or clarification required — see “What each result status means” for the full list.",
      "If your result was rejected or needs clarification, read the review notes: they explain what to fix or what information is missing, and you can respond or resubmit where the process allows.",
      "If your result was approved and later reopens, an administrator has opened it again — usually because of a correction. That's recorded in the result's history.",
    ],
  },
  {
    id: "cannot-edit-verified-result",
    title: "“I cannot edit a verified result.”",
    category: "troubleshooting",
    roles: ["campaign_member", "election_officer"],
    keywords: ["edit", "approved", "correction"],
    body: [
      "Approved results are locked on purpose — they feed official totals, so they can't be edited by the person who submitted them or by officers.",
      "If a verified result contains an error, an administrator performs a correction from the election administration area. The correction and the original figures both stay visible in the result's audit trail.",
      "To request a correction, contact an administrator with the polling unit, contest and what the correct figures should be.",
    ],
  },
  {
    id: "cannot-access-admin",
    title: "“I cannot access Administration.”",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["admin", "administrator"],
    body: [
      "The Admin section is restricted to administrators. There's no way to request access from inside the portal — an existing administrator must set your access role.",
      "Note that holding an organisational position (like coordinator or campaign manager) doesn't by itself make you an administrator. Administration is a separate authority.",
    ],
  },
  {
    id: "data-not-showing",
    title: "“My data isn't showing.”",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["empty", "missing", "not visible", "loading"],
    body: [
      "When a list is empty or a record is missing, work through the likely causes in order:",
      "Scope — the record may belong to an area outside yours (see the scope guide). Status — a news article that is still a draft, a task that's deactivated, or an unverified submission won't appear where you expect. Publication — public site content only appears once published. Verification — task points and official results only exist after verification/approval. Timing — a just-saved change sometimes takes a moment to appear; refresh the page.",
      "If a page fails to load entirely you'll see a message suggesting you try again. If the problem persists after a refresh, check your connection, sign in again, and then report it to an administrator.",
    ],
  },
  {
    id: "when-something-fails",
    title: "When something fails",
    category: "troubleshooting",
    roles: ["all"],
    keywords: ["error", "try again", "network", "support"],
    body: [
      "When an action doesn't succeed, the portal shows a brief message saying what went wrong in plain language — for example a permission problem, a network interruption, or missing information in a form.",
      "Most failures are safe to retry: your work isn't half-applied. Check the message, fix what it points at (a missing field, a proof link, a connection), and try once more.",
      "If a failure keeps happening, note what you were doing and tell an administrator. Developers get the technical detail automatically — you don't need to capture error codes.",
    ],
  },
];

/* --------------------------------------------------------------
 * Role-aware "start here" picks, shown at the top of the guide.
 * -------------------------------------------------------------- */
export const ROLE_INTRO: Record<
  "admin" | "election_officer" | "campaign_member" | "social_member",
  { heading: string; text: string; articles: string[] }
> = {
  admin: {
    heading: "You are an administrator",
    text: "You manage members, content, elections and records for the whole campaign. These articles cover your main tools.",
    articles: ["admin-overview", "manage-members", "election-administration", "donation-ledger"],
  },
  election_officer: {
    heading: "You are an Election Officer",
    text: "You review results, polling-unit reports and incidents across the campaign during election periods. Start here.",
    articles: ["officer-review", "result-statuses", "pu-reports", "election-incidents"],
  },
  campaign_member: {
    heading: "You are a Campaign Member",
    text: "You work on the ground: your area, activities, reports and — at election time — your registered polling unit.",
    articles: ["campaign-council-overview", "result-upload", "pu-reports", "field-reports"],
  },
  social_member: {
    heading: "You are a Social Member",
    text: "You engage with the campaign's public side: social tasks, points and the leaderboard. Election tools are not part of social membership.",
    articles: ["social-tasks", "leaderboard", "membership-types", "your-profile"],
  },
};
