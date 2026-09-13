# Politicore Feature Specifications & Operations Manual

## 1. Overview
This document outlines the core operational features, security boundaries, and user workflows implemented in the Politicore Campaign Management & Multi-Contest Electoral Platform.

---

## 2. Platform Modules & Workflow Guide

### A. Candidate Donation & Contribution Ledger (`/portal/admin/donations`)
- **Purpose:** Private Admin-only record-keeping, audit trail, and analytics system for candidate campaign contributions.
- **Explicit Constraint:** Strictly NOT an online donation/payment collection system. Money is received outside the application via traditional channels; admins manually record confirmed contributions or pledges.
- **Key Features:**
  - Pledged vs Confirmed Received totals. Pledges are explicitly excluded from financial totals until confirmed.
  - Source tracking (Bank Transfer, Cash, POS, Cheque, Other).
  - Donor catalog & contribution history.
  - Immutable audit trail tracking record creation and modifications.

### B. User Lifecycle Management & Member Directory (`/portal/admin/members`)
- **Lifecycle Control:** Administrative controls to `activate`, `suspend`, `deactivate`, or `restore` user accounts with required administrative reason logging.
- **Advanced Directory:** Multi-parameter search by Name, Phone, Email, Membership Type (Campaign vs Social), Access Role, LGA, Ward, Polling Unit, and Lifecycle Status.

### C. Platform-Wide Centralized Audit Logs (`/portal/admin/audit-logs`)
- **Centralized Compliance:** Immutable audit logs recording actor details, affected resource, action type, previous state, and new state.
- **Coverage:** Applied across users, assignments, permissions, donations, tasks, activities, field reports, issues, and election configuration.

### D. Automated In-App Notification System
- **Real-Time Notification Center:** Accessible via the header bell icon in `/portal/layout.tsx`.
- **Targeting:** Supports user-targeted, role-targeted, scope-targeted, and campaign-wide alerts.
- **Job Dispatch:** Server-side job routines in `src/lib/firebase/jobs.ts` process upcoming activity reminders and notification dispatches.

### E. Standalone Attendance System (`/portal/campaign/activities`)
- **RSVP & Turnout:** Activity RSVP options (`Going`, `Interested`, `Not Going`).
- **Check-In / Check-Out:** Direct check-in/out timestamp recording on activity cards with live turnout percentage statistics against expected attendance.

### F. Election Operations & Export Package (`/portal/election/export`)
- **Contest & Cycle Identification:** Operational exports explicitly tagged with Election Cycle and Contest.
- **Multi-Format Export:** Formatted CSV, Excel XML, and PDF Print packages available for PU, Ward, LGA, and State results.

### G. Contextual Help & Portal Guidance (`ContextualHelp.tsx`)
- **Interactive Assistance:** Floating guidance modal accessible across the portal offering tailored instructions for Social Members, Campaign Members, Election Officers, and Admins.
