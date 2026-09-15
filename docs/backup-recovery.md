# Politicore Production Backup, Disaster Recovery and Restoration Guide

## 1. Overview
This document specifies the official application-level disaster recovery, scheduled Firestore backup workflows, and point-in-time restoration procedures for the Politicore Campaign & Multi-Contest Electoral Platform.

---

## 2. Automated Scheduled Firestore Backups

To perform automated nightly backups of critical campaign Firestore collections (`users`, `donations`, `donors`, `election_results`, `system_audits`, `tasks`, `campaign_activities`):

### A. Enable Google Cloud Storage Bucket
```bash
gcloud storage buckets create gs://politicore-backups-ifeanyi-2027 --location=europe-west1
```

### B. Execute On-Demand Firestore Backup
```bash
gcloud firestore export gs://politicore-backups-ifeanyi-2027 --collection-ids=users,donations,donors,election_results,system_audits,tasks,campaign_activities
```

### C. Configure Nightly Cron Backup Job via Cloud Scheduler
```bash
gcloud scheduler jobs create http firestore-nightly-backup \
  --schedule="0 2 * * *" \
  --uri="https://firestore.googleapis.com/v1/projects/ifeanyi-2027/databases/(default):exportDocuments" \
  --message-body='{"outputUriPrefix": "gs://politicore-backups-ifeanyi-2027"}' \
  --oauth-service-account-email="backup-service-account@ifeanyi-2027.iam.gserviceaccount.com"
```

---

## 3. Emergency Restoration & Recovery Workflow

In the event of accidental data corruption or disaster recovery:

### A. Inspect Available Backups
```bash
gcloud storage ls gs://politicore-backups-ifeanyi-2027
```

### B. Restore Specific Collection from Export Snapshot
```bash
gcloud firestore import gs://politicore-backups-ifeanyi-2027/2027-03-30T02:00:00_12345 --collection-ids=donations,election_results
```

---

## 4. Disaster Recovery Audit Checklists

1. Verify Firestore export completion logs in Google Cloud Console.
2. Run automated test suite: `npm run test`.
3. Verify system health at `/portal/admin/health`.
